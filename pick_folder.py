"""Tiny helper: open a native folder picker and print the chosen path.

Run as a subprocess so tkinter's mainloop doesn't tangle with Flask.
"""
import sys
import tkinter as tk
from tkinter import filedialog


def main():
    initial = sys.argv[1] if len(sys.argv) > 1 else None
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    path = filedialog.askdirectory(
        title="Choose download folder",
        initialdir=initial or None,
        mustexist=True,
    )
    root.destroy()
    if path:
        sys.stdout.write(path)


if __name__ == "__main__":
    main()
