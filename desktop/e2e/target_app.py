"""A minimal text editor used as the dictation target in E2E tests: mirrors its contents to a file."""
import sys
import tkinter as tk

out = sys.argv[1]
root = tk.Tk()
root.title("E2E Target Editor")
root.geometry("600x300+50+50")
text = tk.Text(root)
text.pack(fill="both", expand=True)
text.focus_set()


def replace_selection(_):
    # Tk on X11 pastes next to the selection; GTK, browsers and Electron apps replace it (as
    # command mode expects). Behave like them. Widget bindings run before Tk's class binding.
    try:
        text.delete("sel.first", "sel.last")
    except tk.TclError:
        pass


text.bind("<<Paste>>", replace_selection)


def dump():
    with open(out, "w") as f:
        f.write(text.get("1.0", "end-1c"))
    root.after(150, dump)


dump()
root.mainloop()
