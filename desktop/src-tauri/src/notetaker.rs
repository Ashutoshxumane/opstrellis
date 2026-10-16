//! Notetaker: records a meeting (microphone, optionally mixed with a second input such as a
//! system-audio monitor or BlackHole), transcribes it in ~30 s chunks through the normal provider
//! chain while recording, and on stop saves a note with an AI summary (when AI is enabled).

use crate::audio::{self, Recording, SAMPLE_RATE};
use crate::db::Note;
use crate::pipeline::transcribe_with_fallback;
use crate::App;
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

pub struct Meeting {
    stop: Arc<AtomicBool>,
    task: tauri::async_runtime::JoinHandle<()>,
    pub started_at: String,
    pub transcript: Arc<Mutex<String>>,
}

/// Note formats for the AI summary: (id, name, what to write). The transcript has no speaker labels.
pub const TEMPLATES: &[(&str, &str, &str)] = &[
    ("general", "General", "Write concise Markdown with these sections: ## Summary (3-5 sentences), ## Key points (bullets), ## Decisions (bullets, or \"None\"), ## Action items (bullets as \"- [ ] owner: task\" when an owner is mentioned)."),
    ("sales", "Sales call", "This is a sales conversation. Write concise Markdown with these sections: ## Summary (2-3 sentences), ## Customer needs and pain points, ## Current solution, ## Budget, timeline and decision process (write \"Not discussed\" for anything not covered), ## Objections and concerns, ## Next steps (bullets as \"- [ ] owner: task\")."),
    ("interview", "Interview", "This is a job interview. Write concise Markdown with these sections: ## Summary (2-3 sentences), ## Experience and skills discussed (bullets), ## Evidence (notable examples the candidate gave), ## Open questions to follow up, ## Next steps (bullets as \"- [ ] owner: task\"). Report only what was said: no ratings, no hiring recommendation, and nothing about age, gender, origin, health, family or other personal characteristics."),
    ("one_on_one", "1:1", "This is a one-on-one meeting. Write concise Markdown with these sections: ## Updates, ## Blockers and concerns, ## Feedback, ## Decisions, ## Action items (bullets as \"- [ ] owner: task\")."),
    ("standup", "Standup", "This is a team standup. Write concise Markdown with these sections: ## Done, ## Next, ## Blockers, ## Action items (bullets as \"- [ ] owner: task\"). Group by person when names are mentioned."),
];

fn summary_prompt(template: &str) -> String {
    let format = TEMPLATES.iter().find(|(id, ..)| *id == template).unwrap_or(&TEMPLATES[0]).2;
    format!("You write meeting notes from a raw transcript (inside <transcript> tags; speakers are not labelled). {format} Use only information from the transcript. Write in the transcript's language. Output only the notes.")
}

/// Follow-ups drafted from a saved meeting note: (kind, instruction).
const FOLLOW_UPS: &[(&str, &str)] = &[
    ("email", "Draft a short follow-up email to the other participants of this meeting, from the user's point of view: thank them, recap the key points and decisions in a few bullets, and list next steps with owners. Write in the meeting's language. Output only the email body, starting with a greeting, without a subject line or placeholders like [Name]."),
    ("crm", "Write a compact CRM activity note for this meeting as plain text lines in the form \"Field: value\", with these fields: Summary, Needs, Objections, Decision process, Next step, Next step date. Write \"Not discussed\" when the meeting didn't cover a field. Output only the lines."),
];

/// Drafts a follow-up (`kind`: "email" or "crm") from a meeting note's summary and transcript.
pub async fn follow_up(app: &App, note_id: i64, kind: &str) -> Result<String> {
    let instruction = FOLLOW_UPS.iter().find(|(k, _)| *k == kind).map(|(_, i)| *i).ok_or_else(|| anyhow!("Unknown follow-up \"{kind}\""))?;
    let settings = app.settings();
    if !settings.llm.enabled {
        return Err(anyhow!("Follow-ups need AI. Turn on AI polish in Settings → AI."));
    }
    let note = app.db.get_note(note_id)?.filter(|n| n.kind == "meeting").ok_or_else(|| anyhow!("Meeting not found"))?;
    let system = "You help the user follow up on a meeting. The user message contains the meeting notes inside <meeting> tags; use only information from them.";
    let out = app.llm_client(&settings).complete(system, &format!("<meeting>\n{}\n</meeting>\n{instruction}", note.body)).await?;
    crate::llm::check_command_output(None, &out)?;
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStatus {
    pub active: bool,
    /// A stopped meeting is still being transcribed/summarized.
    pub finishing: bool,
    pub started_at: Option<String>,
    pub transcript: String,
}

const CHUNK_MAX: usize = SAMPLE_RATE as usize * 30;
const CHUNK_MIN: usize = SAMPLE_RATE as usize * 10;

pub fn start(app: &Arc<App>, second_device: Option<String>, template: Option<String>) -> Result<()> {
    let mut slot = app.meeting.lock().unwrap();
    if slot.is_some() {
        return Err(anyhow!("A meeting is already being recorded"));
    }
    let settings = app.settings();
    if app.providers(&settings).is_empty() {
        return Err(anyhow!("No transcription provider is enabled"));
    }
    let mic = Recording::start(settings.microphone.clone(), None, |_| {})?;
    let other = match second_device.filter(|d| !d.is_empty()) {
        Some(d) => Some(Recording::start(Some(d), None, |_| {})?),
        None => None,
    };
    let stop = Arc::new(AtomicBool::new(false));
    let transcript = Arc::new(Mutex::new(String::new()));
    let started_at = crate::db::now_rfc3339();
    let template = template.filter(|t| TEMPLATES.iter().any(|(id, ..)| id == t)).unwrap_or_else(|| "general".into());
    let task = tauri::async_runtime::spawn(run(app.clone(), mic, other, stop.clone(), transcript.clone(), started_at.clone(), template));
    *slot = Some(Meeting { stop, task, started_at, transcript });
    let _ = app.handle.emit("meeting-status", ());
    Ok(())
}

pub fn stop(app: &Arc<App>) -> Result<()> {
    let m = app.meeting.lock().unwrap().take().ok_or_else(|| anyhow!("No meeting is being recorded"))?;
    m.stop.store(true, Ordering::SeqCst);
    FINISHING.fetch_add(1, Ordering::SeqCst);
    // The task finishes the last chunk, summarizes and emits `meeting-done`.
    drop(m.task);
    let _ = app.handle.emit("meeting-status", ());
    Ok(())
}

/// Meetings stopped but not yet saved (their task is still finishing).
static FINISHING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub fn status(app: &App) -> MeetingStatus {
    let finishing = FINISHING.load(Ordering::SeqCst) > 0;
    match &*app.meeting.lock().unwrap() {
        Some(m) => MeetingStatus { active: true, finishing, started_at: Some(m.started_at.clone()), transcript: m.transcript.lock().unwrap().clone() },
        None => MeetingStatus { active: false, finishing, started_at: None, transcript: String::new() },
    }
}

/// Mixes the two sources sample-by-sample; the longer one's remainder waits for the next round.
fn mix(a: &mut Vec<i16>, b: &mut Vec<i16>) -> Vec<i16> {
    // If one input stops delivering (unplugged, stream error), treat it as silence instead of
    // holding back the other input forever.
    const MAX_DRIFT: usize = SAMPLE_RATE as usize * 2;
    if a.len() > b.len() + MAX_DRIFT {
        b.resize(a.len(), 0);
    } else if b.len() > a.len() + MAX_DRIFT {
        a.resize(b.len(), 0);
    }
    let n = a.len().min(b.len());
    let out = a[..n].iter().zip(&b[..n]).map(|(x, y)| (*x as i32 + *y as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16).collect();
    a.drain(..n);
    b.drain(..n);
    out
}

async fn run(app: Arc<App>, mic: Recording, other: Option<Recording>, stop: Arc<AtomicBool>, transcript: Arc<Mutex<String>>, started_at: String, template: String) {
    let (mic_buf, other_buf) = (mic.buffer(), other.as_ref().map(|o| o.buffer()));
    let (mut a, mut b) = (Vec::<i16>::new(), Vec::<i16>::new());
    let mut pending: Vec<i16> = Vec::new();
    let mut total_ms = 0i64;
    while !stop.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(500)).await;
        a.extend(std::mem::take(&mut *mic_buf.lock().unwrap()));
        if let Some(ob) = &other_buf {
            b.extend(std::mem::take(&mut *ob.lock().unwrap()));
        }
        pending.extend(if other_buf.is_some() { mix(&mut a, &mut b) } else { std::mem::take(&mut a) });
        // Cut at a pause after 10 s, or hard at 30 s, so words aren't split across chunks.
        let tail_quiet = pending.len() > CHUNK_MIN && audio::is_silent(&pending[pending.len() - SAMPLE_RATE as usize * 6 / 10..]);
        if pending.len() >= CHUNK_MAX || tail_quiet {
            let chunk = std::mem::take(&mut pending);
            total_ms += audio::duration_ms(&chunk);
            transcribe_chunk(&app, &chunk, &transcript).await;
        }
    }
    // Stop the devices first so the final moments are included.
    let mic_rest = tokio::task::spawn_blocking(move || mic.stop()).await.unwrap_or_default();
    a.extend(mic_rest);
    if let Some(o) = other {
        b.extend(tokio::task::spawn_blocking(move || o.stop()).await.unwrap_or_default());
        pending.extend(mix(&mut a, &mut b));
        pending.append(if a.is_empty() { &mut b } else { &mut a });
    } else {
        pending.append(&mut a);
    }
    total_ms += audio::duration_ms(&pending);
    transcribe_chunk(&app, &pending, &transcript).await;

    let text = transcript.lock().unwrap().clone();
    let note = finish_note(&app, &text, &started_at, total_ms, &template).await;
    FINISHING.fetch_sub(1, Ordering::SeqCst);
    let _ = app.handle.emit("meeting-done", serde_json::json!({ "noteId": note.as_ref().ok().and_then(|n| n.id), "error": note.err().map(|e| format!("{e:#}")) }));
}

async fn transcribe_chunk(app: &App, chunk: &[i16], transcript: &Mutex<String>) {
    if audio::is_silent(chunk) {
        return;
    }
    let settings = app.settings();
    let providers = app.providers(&settings);
    let language = Some(settings.language.clone()).filter(|l| l != "auto");
    // One retry: a transient provider error shouldn't drop 30 s of the meeting.
    let mut result = transcribe_with_fallback(&providers, None, chunk, language.as_deref(), &app.vocabulary()).await;
    if result.is_err() {
        tokio::time::sleep(Duration::from_secs(2)).await;
        result = transcribe_with_fallback(&providers, None, chunk, language.as_deref(), &app.vocabulary()).await;
    }
    match result {
        Ok((text, _)) if !crate::stt::clean_transcript(&text).is_empty() => {
            let text = crate::text::apply_dictionary(&crate::stt::clean_transcript(&text), &app.db.list_dictionary().unwrap_or_default());
            let mut t = transcript.lock().unwrap();
            if !t.is_empty() {
                t.push(' ');
            }
            t.push_str(text.trim());
            let _ = app.handle.emit("meeting-transcript", t.clone());
        }
        Ok(_) => {}
        Err(e) => app.report_error(&format!("Notetaker: {e:#}")),
    }
}

async fn finish_note(app: &App, transcript: &str, started_at: &str, total_ms: i64, template: &str) -> Result<Note> {
    if transcript.trim().is_empty() {
        return Err(anyhow!("Nothing was transcribed"));
    }
    let settings = app.settings();
    let when = chrono::DateTime::parse_from_rfc3339(started_at).map(|d| d.format("%b %-d, %H:%M").to_string()).unwrap_or_default();
    let minutes = (total_ms as f64 / 60_000.0).round().max(1.0);
    let mut body = String::new();
    if settings.llm.enabled && settings.llm.provider == crate::polish::PROVIDER {
        body.push_str(&format!(
            "_No summary: {} only polishes dictation. Choose another AI provider in Settings to summarize meetings._\n\n",
            crate::polish::NAME
        ));
    } else if settings.llm.enabled {
        match app.llm_client(&settings).complete(&summary_prompt(template), &format!("<transcript>\n{transcript}\n</transcript>")).await {
            Ok(summary) => body.push_str(&format!("{summary}\n\n")),
            Err(e) => {
                log::warn!("meeting summary failed: {e:#}");
                body.push_str("_No summary: the AI request failed. The transcript is below._\n\n");
            }
        }
    }
    body.push_str(&format!("## Transcript ({minutes} min)\n\n{transcript}"));
    let name = TEMPLATES.iter().find(|(id, ..)| *id == template).map(|t| t.1).filter(|_| template != "general");
    let title = match name {
        Some(name) => format!("Meeting · {when} · {name}"),
        None => format!("Meeting · {when}"),
    };
    app.db.upsert_note(Note { id: None, title, body, updated_at: None, kind: "meeting".into() })
}

#[cfg(test)]
mod tests {
    #[test]
    fn templates() {
        // The general template is the original summary format; unknown ids fall back to it.
        assert!(super::summary_prompt("general").contains("## Key points"));
        assert_eq!(super::summary_prompt("nope"), super::summary_prompt("general"));
        assert!(super::summary_prompt("sales").contains("Objections"));
        assert!(super::summary_prompt("interview").contains("no hiring recommendation"));
        assert!(super::TEMPLATES.iter().all(|t| t.2.contains("- [ ] owner: task")), "action items render as checkboxes");
    }

    #[test]
    fn mixes_and_keeps_remainder() {
        let (mut a, mut b) = (vec![1000i16, 2000, 30000], vec![1000i16, 2000]);
        assert_eq!(super::mix(&mut a, &mut b), vec![2000, 4000]);
        assert_eq!((a, b), (vec![30000], vec![]));
        let (mut a, mut b) = (vec![30000i16], vec![30000i16]);
        assert_eq!(super::mix(&mut a, &mut b), vec![i16::MAX]);
        // A dead second input is padded with silence once it lags by more than 2 s.
        let (mut a, mut b) = (vec![7i16; 40_000], Vec::new());
        assert_eq!(super::mix(&mut a, &mut b).len(), 40_000);
    }
}
