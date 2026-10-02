# xstrace
graphical visualisation of strace log file using js and svg in html page

[you can test actual version](https://allali.github.io/xstrace)

Load a trace generated with

    strace -f -o trace.log ./a.out

and replay it step by step (→ / space: next, ←: previous, P: play/pause).
The page shows, after each syscall, the processes and their fd tables, the
kernel open file descriptions (mode, offset, shared or not) and the files /
pipes they point to; reads and writes are animated along the wires.
The "focus" toggle hides the dynamic loader and the syscalls that are not drawn.

Everything runs in the browser, no data is uploaded.

## Code

- `xstrace.html` (`index.html` is a link to it): page layout
- `js/model.js`: strace log parser and kernel state simulator (also usable from node)
- `js/view.js`: rendering and animations
- `css/xstrace.css`: styles
- `sample/`: example programs and their traces (`make` rebuilds them)
