"""UI end-to-end tests: the real Tauri app (React UI + Rust core) driven through WebDriver
(tauri-driver + WebKitWebDriver). Run via ui_test.sh, which prepares the headless desktop."""
import json, os, subprocess, sys, tempfile, time
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.common.exceptions import JavascriptException, StaleElementReferenceException
from selenium.webdriver.support.ui import WebDriverWait as _Wait

TRANSIENT = (JavascriptException, StaleElementReferenceException)


def WebDriverWait(driver, timeout):  # noqa: N802 - WebKitWebDriver throws transient errors mid-render
    return _Wait(driver, timeout, ignored_exceptions=TRANSIENT)

HERE = Path(__file__).resolve().parent
BIN = os.environ.get("OPSTRELLIS_BIN", str(HERE / "../src-tauri/target/debug/opstrellis"))
SHOTS = Path(os.environ.get("SHOTS", HERE / "../docs-screenshots"))
SHOTS.mkdir(parents=True, exist_ok=True)
LIB = Path("/tmp/probe/sherpa-onnx-moonshine-tiny-en-int8/test_wavs")

data_home = tempfile.mkdtemp()
os.environ["XDG_DATA_HOME"] = data_home
os.environ["XDG_CONFIG_HOME"] = tempfile.mkdtemp()
app_dir = Path(data_home) / "app.opstrellis.desktop"
app_dir.mkdir(parents=True)
(app_dir / "settings.json").write_text(json.dumps({
    "onboarded": True, "language": "en",
    # AI cleanup on (no calls are made in these UI tests) so the auto-transform picker is enabled.
    "llm": {"enabled": True, "provider": "openai", "baseUrl": "http://127.0.0.1:9/v1", "model": "x"},
    "sttChain": [{"id": "local", "provider": "local", "model": "moonshine-tiny-en", "streaming": False, "enabled": True}],
    # Auto-learn is off by default; t_auto_learn needs it.
    "cleanup": {"removeFillers": True, "voiceCommands": True, "autoLearn": True},
}))

driver_proc = subprocess.Popen(["tauri-driver"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
opts = webdriver.ChromeOptions()  # any Options class; tauri-driver reads tauri:options
opts.set_capability("browserName", "wry")
opts.set_capability("tauri:options", {"application": BIN})
d = webdriver.Remote("http://127.0.0.1:4444", options=opts)
wait = WebDriverWait(d, 20)
results = []


def check(name, fn):
    try:
        fn()
        results.append((name, True, ""))
        print(f"PASS  {name}")
    except Exception as e:  # noqa: BLE001
        results.append((name, False, repr(e)))
        print(f"FAIL  {name}: {e!r}")
        d.save_screenshot(str(SHOTS / f"fail-{name.split()[0]}.png"))


def text_present(t, timeout=20):
    WebDriverWait(d, timeout).until(lambda _: t in d.find_element(By.TAG_NAME, "body").text)


# Pages that are tabs under a nav item since the navigation was grouped.
TABS = {"Dictionary": "Library", "Snippets": "Library", "Actions": "Library", "Scratchpad": "Notes", "Notetaker": "Notes"}
TAB_LABEL = {"Scratchpad": "Notes", "Notetaker": "Meetings"}


def nav(label):
    group = TABS.get(label)
    d.find_element(By.XPATH, f"//button[contains(@class,'nav-item')][contains(., '{group or label}')]").click()
    time.sleep(0.4)
    if group:
        tab = TAB_LABEL.get(label, label)
        d.find_element(By.XPATH, f"//header//button[@role='tab'][normalize-space()='{tab}']").click()
        time.sleep(0.4)


def settings_json():
    return json.loads((app_dir / "settings.json").read_text())


def ipc(command, args=None):
    result = d.execute_async_script("""
        const [command, args, done] = arguments;
        window.__TAURI_INTERNALS__.invoke(command, args).then(
            value => done({value}), error => done({error: String(error)}));
    """, command, args or {})
    assert "error" not in result, result
    return result.get("value")


def shot(name):
    d.save_screenshot(str(SHOTS / f"app-{name}.png"))


def t_loads():
    text_present("Home")
    shot("home")


def t_dictionary():
    nav("Dictionary")
    d.find_element(By.XPATH, "//button[contains(., 'Add new')]").click()
    inputs = d.find_elements(By.CSS_SELECTOR, ".modal input")
    inputs[0].send_keys("nest dev")
    inputs[1].send_keys("feature/nest_dev")
    d.find_element(By.XPATH, "//div[contains(@class,'modal')]//button[normalize-space()='Save']").click()
    text_present("feature/nest_dev")
    shot("dictionary")


def t_settings_test_provider():
    nav("Settings")
    d.find_element(By.XPATH, "//button[normalize-space()='Test']").click()
    WebDriverWait(d, 30).until(lambda _: d.find_elements(By.XPATH, "//span[contains(@class,'ok')][contains(., 'yellow lamps')]"))
    shot("settings")


def t_notetaker():
    nav("Notetaker")
    d.find_element(By.XPATH, "//button[contains(., 'Start recording')]").click()
    time.sleep(0.5)
    subprocess.run(["paplay", "--device=vmic", str(LIB / "0.wav")], check=True)
    subprocess.run(["paplay", "--device=vmic", str(LIB / "1.wav")], check=True)
    text_present("yellow lamps", timeout=40)  # live transcript while recording
    shot("notetaker-live")
    d.find_element(By.XPATH, "//button[contains(., 'Stop')]").click()
    WebDriverWait(d, 40).until(lambda _: d.find_elements(By.CSS_SELECTOR, ".meeting-note"))
    body = d.find_element(By.CSS_SELECTOR, ".meeting-note").text.lower()
    assert "yellow lamps" in body and "lovely child" in body, body[:300]
    shot("notetaker-done")


def t_auto_learn():
    import sqlite3
    db = sqlite3.connect(app_dir / "opstrellis.db")
    db.execute(
        "INSERT INTO history (created_at, raw_text, text, app_name, category, provider, model, audio_ms, latency_ms, words, status, mode)"
        " VALUES (datetime('now'), ?, ?, 'Slack', 'work_messages', 'local', 'm', 3000, 300, 9, 'ok', 'dictate')",
        ("ask karl to merge nest dev today", "Ask Karl to merge nest dev today."),
    )
    db.commit()
    nav("Insights")
    nav("Home")
    d.find_element(By.XPATH, "//button[@title='Correct']").click()
    area = d.find_element(By.CSS_SELECTOR, "textarea.edit-area")
    area.clear()
    area.send_keys("Ask Karol to merge feature/nest_dev today.")
    d.find_element(By.XPATH, "//button[normalize-space()='Save correction']").click()
    text_present("Added to your dictionary")
    shot("auto-learn")
    nav("Dictionary")
    text_present("feature/nest_dev")
    body = d.find_element(By.TAG_NAME, "body").text
    assert "Karol" in body and "Learned" in body, body[:400]


def t_learn_pending_and_undo():
    """A fix that doesn't sound like a mis-hearing is learned only the second time, and Undo removes it."""
    import sqlite3
    def correct(text, fixed):
        db = sqlite3.connect(app_dir / "opstrellis.db")
        db.execute(
            "INSERT INTO history (created_at, raw_text, text, app_name, category, provider, model, audio_ms, latency_ms, words, status, mode)"
            " VALUES (datetime('now'), ?, ?, 'Slack', 'work_messages', 'local', 'm', 3000, 300, 5, 'ok', 'dictate')",
            (text.lower(), text),
        )
        db.commit()
        nav("Insights")
        nav("Home")
        d.find_element(By.XPATH, "//button[@title='Correct']").click()  # newest first
        area = d.find_element(By.CSS_SELECTOR, "textarea.edit-area")
        area.clear()
        area.send_keys(fixed)
        d.find_element(By.XPATH, "//button[normalize-space()='Save correction']").click()
    correct("Send it to Bob today.", "Send it to Alice today.")
    text_present("Make the same fix once more to learn Bob → Alice")
    correct("Bob will review it.", "Alice will review it.")
    text_present("Added to your dictionary: Bob → Alice")
    d.find_element(By.XPATH, "//button[normalize-space()='Undo']").click()
    nav("Dictionary")
    text_present("Karol")
    assert "Alice" not in d.find_element(By.TAG_NAME, "body").text


def t_auto_transform_setting():
    nav("Style")
    sel = d.find_element(By.CSS_SELECTOR, "select[aria-label='Auto action for Personal']")
    sel.find_element(By.XPATH, ".//option[normalize-space()='Polish']").click()
    WebDriverWait(d, 10).until(lambda _: json.loads((app_dir / "settings.json").read_text()).get("autoTransforms", {}).get("personal"))
    shot("style")


def t_style_ai_prompts_and_apps():
    nav("Style")
    d.find_element(By.XPATH, "//button[@role='tab'][normalize-space()='AI prompts']").click()
    d.find_element(By.XPATH, "//button[@role='radio'][normalize-space()='Structured']").click()
    d.find_element(By.CSS_SELECTOR, ".notes-field textarea").send_keys("Keep library names exact.")
    WebDriverWait(d, 10).until(lambda _: settings_json().get("promptStyle") == "structured"
                               and settings_json().get("styleNotes", {}).get("ai") == "Keep library names exact.")
    d.find_element(By.CSS_SELECTOR, "input[aria-label='App name or window title']").send_keys("HubSpot")
    d.find_element(By.CSS_SELECTOR, "select[aria-label='Kind of app']").find_element(By.XPATH, ".//option[normalize-space()='Emails']").click()
    d.find_element(By.XPATH, "//button[normalize-space()='Add']").click()
    WebDriverWait(d, 10).until(lambda _: settings_json().get("appCategories", {}).get("hubspot") == "emails")
    # Slack is in history (auto-learn tests): it's listed with its detected kind.
    text_present("Auto (Work messages)")
    shot("style-ai")


def t_action_output():
    import sqlite3
    nav("Actions")
    text_present("Copies result")  # built-in Reply / Summarize
    d.find_element(By.XPATH, "//button[contains(., 'New action')]").click()
    d.find_element(By.CSS_SELECTOR, ".modal input").send_keys("Decline politely")
    d.find_element(By.CSS_SELECTOR, ".modal textarea").send_keys("Write a polite reply declining the request.")
    d.find_element(By.XPATH, "//div[contains(@class,'modal')]//option[@value='copy']").click()
    d.find_element(By.XPATH, "//div[contains(@class,'modal')]//button[normalize-space()='Save']").click()
    text_present("Decline politely")
    row = sqlite3.connect(app_dir / "opstrellis.db").execute("SELECT output FROM transforms WHERE name = 'Decline politely'").fetchone()
    assert row == ("copy",), row
    shot("actions")


def t_ai_test_and_repolish_errors():
    """AI is configured against an unreachable endpoint: both the Test button and Polish again say so."""
    nav("Settings")
    d.find_element(By.XPATH, "//section[@id='s-ai']//button[normalize-space()='Test']").click()
    WebDriverWait(d, 20).until(lambda _: d.find_elements(By.XPATH, "//section[@id='s-ai']//span[contains(@class,'error')]"))
    nav("Home")
    d.find_element(By.XPATH, "//button[normalize-space()='Show original']").click()
    assert d.find_element(By.CSS_SELECTOR, ".li-original").text, "original transcript shown"
    before = d.find_element(By.CSS_SELECTOR, ".list-row .li-title").text
    d.find_element(By.XPATH, "//button[@title='Polish again with AI']").click()
    WebDriverWait(d, 20).until(lambda _: "AI polish unavailable" in d.find_element(By.TAG_NAME, "body").text)
    assert d.find_element(By.CSS_SELECTOR, ".list-row .li-title").text == before, "text unchanged on failure"
    shot("history-original")


def t_meeting_templates():
    nav("Notetaker")
    sel = d.find_element(By.CSS_SELECTOR, "select[aria-label='Notes format']")
    names = [o.text for o in sel.find_elements(By.TAG_NAME, "option")]
    assert names == ["General", "Sales call", "Interview", "1:1", "Standup"], names


def t_overlay_restart_during_linger():
    nav("Home")
    ipc("start_dictation")
    WebDriverWait(d, 10).until(lambda _: d.find_element(By.CSS_SELECTOR, ".status-label").text == "Listening…")
    ipc("stop_dictation")  # silent: warning lingers for 3 seconds
    WebDriverWait(d, 10).until(lambda _: d.find_element(By.CSS_SELECTOR, ".status-label").text == "Ready")
    ipc("start_dictation")
    try:
        WebDriverWait(d, 10).until(lambda _: d.find_element(By.CSS_SELECTOR, ".status-label").text == "Listening…")
        time.sleep(3.2)
        assert ipc("plugin:window|is_visible", {"label": "overlay"}), "old outcome timer hid the new recording"
    finally:
        ipc("cancel_dictation")


def t_fallback_shortcut_after_changing_primary():
    old = ipc("get_settings")
    settings = json.loads(json.dumps(old))
    settings["hotkeys"]["dictate"] = "Ctrl+Alt+Shift+F10"
    try:
        ipc("save_settings", {"settings": settings})
        subprocess.run(["xdotool", "key", "ctrl+shift+space"], check=True)
        WebDriverWait(d, 10).until(lambda _: d.find_element(By.CSS_SELECTOR, ".status-label").text == "Listening…")
        subprocess.run(["xdotool", "key", "ctrl+shift+space"], check=True)
        WebDriverWait(d, 10).until(lambda _: d.find_element(By.CSS_SELECTOR, ".status-label").text == "Ready")
    finally:
        ipc("cancel_dictation")
        ipc("save_settings", {"settings": old})


def t_repolish_keeps_context_and_concurrent_correction():
    import sqlite3
    old = ipc("get_settings")
    reqlog = Path(tempfile.mktemp())
    standin = subprocess.Popen([sys.executable, str(HERE / "llm_standin.py"), "8801", str(reqlog)],
                               env={**os.environ, "STANDIN_DELAY_MS": "700"})
    row_id = None
    try:
        time.sleep(0.3)
        settings = json.loads(json.dumps(old))
        settings["llm"].update(enabled=True, provider="openai", baseUrl="http://127.0.0.1:8801/v1", model="test")
        ipc("save_settings", {"settings": settings})
        with sqlite3.connect(app_dir / "opstrellis.db") as db:
            row_id = db.execute(
                "INSERT INTO history (created_at, raw_text, text, app_name, category, audio_ms, latency_ms, words, status, mode) "
                "VALUES (datetime('now'), 'hello sam', 'Original message', 'Firefox', 'emails', 1000, 100, 2, 'ok', 'dictate')"
            ).lastrowid
        d.execute_script("""
            window.repolishResult = null;
            window.__TAURI_INTERNALS__.invoke('repolish_history', {id: arguments[0]}).then(
                text => window.repolishResult = {text}, error => window.repolishResult = {error: String(error)});
        """, row_id)
        WebDriverWait(d, 10).until(lambda _: reqlog.exists() and reqlog.stat().st_size > 0)
        request = json.loads(reqlog.read_text().splitlines()[0])
        assert "category: emails" in request["system"], request["system"][:300]
        ipc("update_history", {"id": row_id, "text": "Newer correction"})
        WebDriverWait(d, 10).until(lambda _: d.execute_script("return window.repolishResult !== null"))
        result = d.execute_script("return window.repolishResult")
        assert "changed while polishing" in result.get("error", ""), result
        with sqlite3.connect(app_dir / "opstrellis.db") as db:
            assert db.execute("SELECT text FROM history WHERE id=?", (row_id,)).fetchone() == ("Newer correction",)
    finally:
        ipc("save_settings", {"settings": old})
        if row_id is not None:
            ipc("delete_history", {"id": row_id})
        standin.terminate()
        standin.wait(timeout=5)
        reqlog.unlink(missing_ok=True)


def t_meeting_named_note_stays_a_note():
    note = ipc("upsert_note", {"note": {"title": "Meeting prep", "body": "Prepare agenda"}})
    try:
        assert any(n["id"] == note["id"] for n in ipc("list_notes", {"kind": "note"}))
        assert all(n["id"] != note["id"] for n in ipc("list_notes", {"kind": "meeting"}))
    finally:
        ipc("delete_note", {"id": note["id"]})


def t_pages_render():
    for label in ["Insights", "Snippets", "Style", "Actions", "Scratchpad", "Home"]:
        nav(label)
        assert "Something went wrong" not in d.find_element(By.TAG_NAME, "body").text
        shot(label.lower())


try:
    check("app loads", t_loads)
    check("dictionary add via UI", t_dictionary)
    check("settings: test local provider", t_settings_test_provider)
    check("notetaker records, transcribes live, saves note", t_notetaker)
    check("auto-learn from a corrected dictation", t_auto_learn)
    check("auto-learn: pending until repeated, undo", t_learn_pending_and_undo)
    check("auto transform setting is saved", t_auto_transform_setting)
    check("style: AI prompts tab, prompt style, notes, app rule", t_style_ai_prompts_and_apps)
    check("actions: copy output saved", t_action_output)
    check("AI test + polish again report an unreachable provider", t_ai_test_and_repolish_errors)
    check("meeting templates listed", t_meeting_templates)
    check("fallback toggles after changing the primary shortcut", t_fallback_shortcut_after_changing_primary)
    check("overlay restart survives the previous outcome timer", t_overlay_restart_during_linger)
    check("repolish keeps captured category and newer corrections", t_repolish_keeps_context_and_concurrent_correction)
    check("a note named Meeting prep stays in Notes", t_meeting_named_note_stays_a_note)
    check("all pages render", t_pages_render)
finally:
    d.quit()
    driver_proc.terminate()
failed = [r for r in results if not r[1]]
print(f"{len(results) - len(failed)}/{len(results)} UI tests passed")
sys.exit(1 if failed else 0)
