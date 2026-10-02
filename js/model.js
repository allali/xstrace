/*
 * xstrace — model: strace log parser + kernel state simulator.
 *
 * parseTrace(text)  -> list of events (one per syscall / signal / exit)
 * simulate(events)  -> { steps, mainStart }  where steps[i].state is the
 *                      state of processes / open file descriptions / files
 *                      *after* event i.
 *
 * Works in the browser (window.XModel) and in node (module.exports).
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Low level helpers                                                   */
  /* ------------------------------------------------------------------ */

  // index of the ')' matching an already opened '(' (scan starts at `start`)
  function scanParen(s, start) {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (c === '"') {
        for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) return c === ')' ? i : -1;
        depth--;
      }
    }
    return -1;
  }

  // split "a, "b,c", [1, 2], {x=1, y=2}" on top level commas
  function splitArgs(s) {
    const out = [];
    let depth = 0, cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') {
        let j = i + 1;
        for (; j < s.length && s[j] !== '"'; j++) if (s[j] === '\\') j++;
        cur += s.slice(i, j + 1);
        i = j;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim() !== '') out.push(cur.trim());
    return out;
  }

  // decode a strace string literal: "abc\n"... -> {text, truncated}
  function decodeStr(tok) {
    if (!tok || tok[0] !== '"') return null;
    let i = 1, text = '';
    for (; i < tok.length && tok[i] !== '"'; i++) {
      let c = tok[i];
      if (c !== '\\') { text += c; continue; }
      c = tok[++i];
      if (c === 'n') text += '\n';
      else if (c === 't') text += '\t';
      else if (c === 'r') text += '\r';
      else if (c === 'v') text += '\v';
      else if (c === 'f') text += '\f';
      else if (c === 'x') { text += String.fromCharCode(parseInt(tok.substr(i + 1, 2), 16)); i += 2; }
      else if (c >= '0' && c <= '7') {
        let o = c;
        while (o.length < 3 && tok[i + 1] >= '0' && tok[i + 1] <= '7') o += tok[++i];
        text += String.fromCharCode(parseInt(o, 8));
      } else text += c;
    }
    return { text, truncated: tok.slice(i + 1).startsWith('...') };
  }

  function intList(tok) {
    return (tok || '').replace(/[\[\]]/g, '').split(',').map(x => parseInt(x, 10)).filter(x => !isNaN(x));
  }

  function basename(p) { const s = p.split('/'); return s[s.length - 1] || p; }

  /* ------------------------------------------------------------------ */
  /* Parser                                                              */
  /* ------------------------------------------------------------------ */

  const PREFIX_RE = /^(?:\[pid\s+(\d+)\]\s+|(\d+)\s+)?(?:(?:\d{1,2}:\d{2}:\d{2}(?:\.\d+)?|\d+\.\d+)\s+)?/;
  // syscalls whose effect must be visible *before* the lines that follow the
  // "<unfinished ...>" (the child of a fork may run before clone() resumes)
  const EARLY = new Set(['clone', 'clone3', 'fork', 'vfork']);

  function parseResult(tail) {
    tail = tail.replace(/\s+<\d+(?:\.\d+)?>\s*$/, ''); // strace -T
    const m = /^\s*=\s*(\S+)(?:\s+(.*))?$/.exec(tail);
    if (!m) return { ret: '?', retn: NaN, err: null, errmsg: null };
    const ret = m[1], rest = m[2] || '';
    const e = /^(E[A-Z0-9]+)\s*(?:\((.*)\))?/.exec(rest);
    return { ret, retn: Number(ret), err: e ? e[1] : null, errmsg: e ? (e[2] || '') : null };
  }

  function makeCall(pid, name, body, lineno) {
    // body = everything after "name(" up to the end of the line
    const close = scanParen(body, 0);
    const argstr = close < 0 ? body : body.slice(0, close);
    const res = close < 0 ? parseResult('') : parseResult(body.slice(close + 1));
    return Object.assign({
      kind: 'syscall', pid, name, argstr, args: splitArgs(argstr),
      raw: name + '(' + argstr + ')' + (close < 0 ? '' : ' = ' + res.ret + (res.err ? ' ' + res.err + (res.errmsg ? ' (' + res.errmsg + ')' : '') : '')),
      line: lineno
    }, res);
  }

  function parseTrace(text) {
    const lines = text.split('\n');
    const out = [];
    const pending = {};
    let firstPid = null;

    lines.forEach((line, n) => {
      line = line.replace(/\r$/, '');
      if (!line.trim() || line.startsWith('strace:')) return;
      const pm = PREFIX_RE.exec(line);
      const pid = pm[1] || pm[2] || firstPid || 'main';
      if (firstPid === null) firstPid = pid;
      const rest = line.slice(pm[0].length).trim();
      const lineno = n + 1;
      let m;

      if ((m = /^\+\+\+ exited with (-?\d+) \+\+\+$/.exec(rest))) {
        out.push({ kind: 'exit', pid, code: +m[1], raw: rest, line: lineno });
      } else if ((m = /^\+\+\+ killed by (SIG\w+)(.*)\+\+\+$/.exec(rest))) {
        out.push({ kind: 'killed', pid, signal: m[1], core: /core dumped/.test(m[2]), raw: rest, line: lineno });
      } else if ((m = /^--- (SIG\w+) (.*) ---$/.exec(rest))) {
        out.push({ kind: 'signal', pid, signal: m[1], info: m[2], raw: rest, line: lineno });
      } else if ((m = /^<\.\.\. (\w+) resumed>\s*(.*)$/.exec(rest))) {
        const u = pending[pid];
        delete pending[pid];
        const head = u && u.name === m[1] ? u.head.replace(/,\s*$/, ', ') : '';
        const ev = makeCall(pid, m[1], head + m[2], lineno);
        if (u && u.slot !== undefined) out[u.slot] = ev; else out.push(ev);
      } else if ((m = /^(\w+)\((.*?)\s*<unfinished \.\.\.>$/.exec(rest))) {
        const u = pending[pid] = { name: m[1], head: m[2] };
        if (EARLY.has(m[1])) { u.slot = out.length; out.push(null); }
      } else if ((m = /^(\w+)\((.*)$/.exec(rest))) {
        out.push(makeCall(pid, m[1], m[2], lineno));
      }
    });
    // syscalls that never came back (process killed while blocked)
    for (const pid in pending) {
      const u = pending[pid];
      if (u.slot !== undefined) out[u.slot] = makeCall(pid, u.name, u.head + ') = ?', 0);
    }
    return out.filter(Boolean).map((ev, i) => (ev.i = i, ev));
  }

  /* ------------------------------------------------------------------ */
  /* Simulator                                                           */
  /* ------------------------------------------------------------------ */

  // files opened by the dynamic loader / libc initialisation, hidden in focus mode
  const LOADER_RE = /(\.so(\.[\d.]+)?$)|ld\.so\.(cache|preload)|glibc-hwcaps|\/locale|locale\.alias|gconv|\.mo$/;
  const PREVIEW_MAX = 400;

  function show(t, max) {
    const s = t.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
      .replace(/[\x00-\x1f\x7f-\x9f]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    return max && s.length > max ? s.slice(0, max) + '…' : s;
  }

  function modeOf(flags) {
    return /O_RDWR/.test(flags) ? 'RW' : /O_WRONLY/.test(flags) ? 'W' : 'R';
  }
  const MODE_WORD = { R: 'reading', W: 'writing', RW: 'reading and writing' };

  function Sim() {
    this.S = { procs: {}, ofds: {}, nodes: {}, tid: {} };
    this.next = 1;
    this.order = 0;
  }

  Sim.prototype = {
    node(kind, label, extra) {
      const id = 'n' + this.next++;
      return (this.S.nodes[id] = Object.assign({ id, kind, label, content: '', size: 0 }, extra || {}));
    },
    ofd(node, mode, extra) {
      const id = 'o' + this.next++;
      return (this.S.ofds[id] = Object.assign({ id, node: node.id, mode, offset: 0, append: false, flags: '' }, extra || {}));
    },
    pidOf(pid) { return this.S.tid[pid] || pid; },
    proc(pid) {
      pid = this.pidOf(pid);
      let p = this.S.procs[pid];
      if (!p) {
        p = this.S.procs[pid] = { pid, ppid: null, bin: '?', argv: [], status: 'running', code: null, fds: {}, order: this.order++ };
        if (p.order === 0) {
          // the traced program inherits its standard streams from the shell
          const tty = this.node('tty', 'terminal');
          p.fds[0] = { ofd: this.ofd(tty, 'R', { std: 'stdin' }).id, cloexec: false };
          p.fds[1] = { ofd: this.ofd(tty, 'W', { std: 'stdout' }).id, cloexec: false };
          p.fds[2] = { ofd: this.ofd(tty, 'W', { std: 'stderr' }).id, cloexec: false };
        }
      }
      return p;
    },
    fdInfo(p, fd) {
      const f = p.fds[fd];
      if (!f) return null;
      const o = this.S.ofds[f.ofd];
      return { f, o, n: this.S.nodes[o.node] };
    },
    nodeName(n) {
      if (n.kind === 'pipe') return 'pipe #' + n.num;
      if (n.kind === 'tty') return 'the terminal';
      if (n.kind === 'socket') return n.label;
      return '"' + n.label + '"';
    },
    gc() {
      const S = this.S, used = new Set(), usedN = new Set();
      for (const pid in S.procs) for (const fd in S.procs[pid].fds) used.add(S.procs[pid].fds[fd].ofd);
      for (const id in S.ofds) if (!used.has(id)) delete S.ofds[id]; else usedN.add(S.ofds[id].node);
      for (const id in S.nodes) if (!usedN.has(id)) delete S.nodes[id];
    },
    // remove a process from the table (reaped)
    reap(pid) {
      const S = this.S;
      delete S.procs[pid];
      for (const t in S.tid) if (S.tid[t] === pid) delete S.tid[t];
    },
    terminate(p, how, ctx) {
      const S = this.S;
      const fds = Object.keys(p.fds);
      p.fds = {};
      p.code = how;
      const parent = p.ppid && S.procs[p.ppid];
      let fate;
      if (parent && parent.status === 'running') {
        p.status = 'zombie';
        fate = 'it stays a zombie until its parent calls wait()';
      } else if (p.ppid) {
        this.reap(p.pid);
        fate = 'its parent is gone, so init reaps it immediately';
      } else {
        p.status = 'exited';
        fate = 'the shell collects its exit status';
      }
      // zombie children of a dying process are reaped by init
      for (const c in S.procs) if (S.procs[c].ppid === p.pid && S.procs[c].status === 'zombie') this.reap(c);
      ctx.desc += (fds.length ? ' The kernel closes its ' + fds.length + ' open fd' + (fds.length > 1 ? 's' : '') + ' (' + fds.join(', ') + ');' : '') + ' ' + fate + '.';
      ctx.hot.procs.push(p.pid);
    },
    closeFd(p, fd) {
      delete p.fds[fd];
    },
    flow(ctx, dir, p, fd, info, n, data) {
      ctx.fx.push({ type: 'flow', dir, pid: p.pid, fd, ofd: info.o.id, node: info.n.id, n, data });
    },
    learn(node, off, n, d) {
      // keep an approximate copy of the file contents for display
      if (!d || node.content.length >= PREVIEW_MAX || off > node.content.length) return;
      const t = (d.text + (d.truncated ? '…'.repeat(Math.max(0, n - d.text.length)) : '')).slice(0, n);
      node.content = (node.content.slice(0, off) + t + node.content.slice(off + t.length)).slice(0, PREVIEW_MAX);
    }
  };

  /* --- one handler per syscall. Return false when nothing changed. ---- */

  const H = {};

  H.execve = H.execveat = function (ev, p, ctx) {
    const path = (decodeStr(ev.args[ev.name === 'execveat' ? 1 : 0]) || { text: '?' }).text;
    const argvTok = ev.args[ev.name === 'execveat' ? 2 : 1] || '';
    p.argv = splitArgs(argvTok.replace(/^\[|\]$/g, '')).map(a => (decodeStr(a) || { text: a }).text);
    p.bin = basename(path);
    const closed = [];
    for (const fd in p.fds) if (p.fds[fd].cloexec) { closed.push(fd); this.closeFd(p, fd); }
    ctx.desc = 'Replaces the program of process ' + p.pid + ' by ' + path + '. Code and memory are replaced, the fd table is kept'
      + (closed.length ? ' except close-on-exec fds (' + closed.join(', ') + ') which are closed.' : '.');
    ctx.fx.push({ type: 'exec', pid: p.pid });
  };

  function doOpen(ev, p, ctx, path, flags) {
    const fd = ev.retn;
    const mode = modeOf(flags);
    let node = Object.values(this.S.nodes).find(n => n.kind === 'file' && n.label === path);
    const shared = !!node;
    if (!node) node = this.node('file', path, { loader: LOADER_RE.test(path), dir: /O_DIRECTORY/.test(flags) });
    if (/O_TRUNC/.test(flags)) { node.content = ''; node.size = 0; }
    const shortFlags = flags.split('|').filter(f => /APPEND|CREAT|TRUNC|CLOEXEC|NONBLOCK|DIRECTORY|EXCL/.test(f)).map(f => f.replace('O_', '')).join(' ');
    const o = this.ofd(node, mode, { append: /O_APPEND/.test(flags), flags: shortFlags });
    if (p.fds[fd]) this.closeFd(p, fd);
    p.fds[fd] = { ofd: o.id, cloexec: /O_CLOEXEC/.test(flags) };
    ctx.desc = 'Opens ' + this.nodeName(node) + ' for ' + MODE_WORD[mode]
      + '. The kernel creates a new open file description (offset 0) and returns the lowest free fd: ' + fd + '.'
      + (shared ? ' The file was already open: both descriptions point to the same file but have their own offset.' : '');
    ctx.hot.fds.push(fd); ctx.hot.ofds.push(o.id); ctx.hot.nodes.push(node.id);
  }
  H.open = function (ev, p, ctx) { doOpen.call(this, ev, p, ctx, decodeStr(ev.args[0]).text, ev.args[1] || ''); };
  H.openat = function (ev, p, ctx) { doOpen.call(this, ev, p, ctx, decodeStr(ev.args[1]).text, ev.args[2] || ''); };
  H.openat2 = function (ev, p, ctx) { doOpen.call(this, ev, p, ctx, decodeStr(ev.args[1]).text, (/flags=([\w|]+)/.exec(ev.args[2] || '') || [, ''])[1]); };
  H.creat = function (ev, p, ctx) { doOpen.call(this, ev, p, ctx, decodeStr(ev.args[0]).text, 'O_WRONLY|O_CREAT|O_TRUNC'); };

  H.close = function (ev, p, ctx) {
    const fd = parseInt(ev.args[0], 10);
    const info = this.fdInfo(p, fd);
    if (!info) return false;
    this.closeFd(p, fd);
    this.gc();
    const still = this.S.ofds[info.o.id];
    ctx.desc = 'Closes fd ' + fd + '. ' + (still
      ? 'The open file description is still used by another fd, so it stays alive.'
      : 'It was the last reference to its open file description, which is freed'
        + (this.S.nodes[info.n.id] ? '.' : ' along with ' + this.nodeName(info.n) + ' (no longer open anywhere).'))
      + (info.n.kind === 'pipe' && info.o.mode === 'W' && !still ? ' Readers of the pipe will now get end-of-file once it is empty.' : '');
    ctx.hot.ofds.push(info.o.id); ctx.hot.nodes.push(info.n.id);
  };

  H.close_range = function (ev, p, ctx) {
    const lo = parseInt(ev.args[0], 10), hiTok = ev.args[1] || '';
    const hi = /~0|4294967295/.test(hiTok) ? Infinity : parseInt(hiTok, 10);
    const cloexec = /CLOSE_RANGE_CLOEXEC/.test(ev.args[2] || '');
    const touched = Object.keys(p.fds).map(Number).filter(fd => fd >= lo && fd <= hi);
    if (!touched.length) return false;
    touched.forEach(fd => cloexec ? (p.fds[fd].cloexec = true) : this.closeFd(p, fd));
    ctx.desc = (cloexec ? 'Marks close-on-exec' : 'Closes') + ' fds ' + touched.join(', ') + '.';
  };

  function doRW(ev, p, ctx, dir) {
    const fd = parseInt(ev.args[0], 10);
    const info = this.fdInfo(p, fd);
    if (!info) return false;
    const { o, n } = info;
    const count = ev.retn;
    const positional = /^p(read|write)/.test(ev.name);
    let d = null;
    if (/v$/.test(ev.name)) {
      const parts = [...(ev.args[1] || '').matchAll(/iov_base=("(?:[^"\\]|\\.)*"(?:\.\.\.)?)/g)].map(m => decodeStr(m[1]));
      if (parts.length) d = { text: parts.map(x => x.text).join(''), truncated: parts.some(x => x.truncated) };
    } else d = decodeStr(ev.args[1]);
    const off = positional ? parseInt(ev.args[3], 10) : (dir === 'out' && o.append ? n.size : o.offset);
    const what = this.nodeName(n);
    ctx.hot.fds.push(fd); ctx.hot.ofds.push(o.id); ctx.hot.nodes.push(n.id);
    ctx.dir = dir;

    if (dir === 'in') {
      if (count === 0) {
        ctx.desc = 'Reads from fd ' + fd + ' (' + what + '): returns 0, end of file'
          + (n.kind !== 'pipe' ? '.'
            : !Object.values(this.S.ofds).some(x => x.node === n.id && x.mode === 'W')
              ? ' — the pipe is empty and no process holds its write end anymore.'
              : ' — the pipe is empty and its writers are gone. (A write end still looks open here: with -f, strace prints lines when syscalls complete, so the order can differ slightly from reality.)');
        return;
      }
      if (n.kind === 'pipe') {
        // with -f, strace may print a read before the write that fed it
        const take = Math.min(count, n.content.length);
        n.content = n.content.slice(take);
        n.debt = (n.debt || 0) + count - take;
      }
      else if (n.kind === 'file') { this.learn(n, off, count, d); n.size = Math.max(n.size, off + count); }
    } else {
      if (n.kind === 'pipe') {
        const paid = Math.min(n.debt || 0, count);
        n.debt = (n.debt || 0) - paid;
        n.content = (n.content + (d ? d.text : '').slice(paid)).slice(-PREVIEW_MAX);
      }
      else if (n.kind === 'tty') n.content = (n.content + (d ? d.text + (d.truncated ? '…' : '') : '')).slice(-PREVIEW_MAX);
      else { this.learn(n, off, count, d); n.size = Math.max(n.size, off + count); }
    }
    const before = o.offset;
    if (!positional && n.kind === 'file') o.offset = off + count;
    ctx.desc = (dir === 'in' ? 'Reads ' : 'Writes ') + count + ' byte' + (count > 1 ? 's' : '')
      + (dir === 'in' ? ' from ' : ' to ') + 'fd ' + fd + ' (' + what + ')'
      + (n.kind === 'file' ? (positional ? ' at offset ' + off + ' (pread/pwrite do not move the offset).' : '; the offset moves ' + before + ' → ' + o.offset + '.')
        : n.kind === 'pipe' ? (dir === 'in' ? '; those bytes are removed from the pipe buffer.' : '; they wait in the pipe buffer until someone reads them.') : '.');
    this.flow(ctx, dir, p, fd, info, count, d ? d.text : '');
  }
  H.read = H.pread64 = H.readv = H.preadv = H.recvfrom = function (ev, p, ctx) { return doRW.call(this, ev, p, ctx, 'in'); };
  H.write = H.pwrite64 = H.writev = H.pwritev = H.sendto = function (ev, p, ctx) { return doRW.call(this, ev, p, ctx, 'out'); };

  H.lseek = function (ev, p, ctx) {
    const fd = parseInt(ev.args[0], 10);
    const info = this.fdInfo(p, fd);
    if (!info) return false;
    const before = info.o.offset;
    info.o.offset = ev.retn;
    ctx.desc = 'Moves the offset of fd ' + fd + ' (' + ev.args[2] + '): ' + before + ' → ' + ev.retn + '.';
    ctx.hot.fds.push(fd); ctx.hot.ofds.push(info.o.id);
  };

  function doDup(ev, p, ctx, from, to, cloexec) {
    const info = this.fdInfo(p, from);
    if (!info) return false;
    const replaced = p.fds[to] && to !== from ? this.fdInfo(p, to) : null;
    if (to === from) { ctx.desc = 'dup2(' + from + ', ' + to + '): same fd, nothing to do.'; return; }
    p.fds[to] = { ofd: info.o.id, cloexec: !!cloexec };
    this.gc();
    ctx.desc = (replaced ? 'fd ' + to + ' was open: it is closed first. ' : '')
      + 'fd ' + to + ' now refers to the same open file description as fd ' + from + ' (' + this.nodeName(info.n) + '): they share the offset.';
    ctx.hot.fds.push(from, to); ctx.hot.ofds.push(info.o.id);
  }
  H.dup = function (ev, p, ctx) { return doDup.call(this, ev, p, ctx, parseInt(ev.args[0], 10), ev.retn, false); };
  H.dup2 = function (ev, p, ctx) { return doDup.call(this, ev, p, ctx, parseInt(ev.args[0], 10), parseInt(ev.args[1], 10), false); };
  H.dup3 = function (ev, p, ctx) { return doDup.call(this, ev, p, ctx, parseInt(ev.args[0], 10), parseInt(ev.args[1], 10), /O_CLOEXEC/.test(ev.args[2])); };
  H.fcntl = H.fcntl64 = function (ev, p, ctx) {
    const fd = parseInt(ev.args[0], 10), cmd = ev.args[1];
    if (/^F_DUPFD/.test(cmd)) return doDup.call(this, ev, p, ctx, fd, ev.retn, cmd === 'F_DUPFD_CLOEXEC');
    if (cmd === 'F_SETFD' && p.fds[fd]) {
      p.fds[fd].cloexec = /FD_CLOEXEC/.test(ev.args[2]);
      ctx.desc = 'fd ' + fd + (p.fds[fd].cloexec ? ' will be closed on exec.' : ' will survive exec.');
      ctx.hot.fds.push(fd);
      return;
    }
    return false;
  };

  H.pipe = H.pipe2 = function (ev, p, ctx) {
    const [r, w] = intList(ev.args[0]);
    const pipe = this.node('pipe', 'pipe', { num: ++this.pipes });
    const cloexec = /O_CLOEXEC/.test(ev.args[1] || '');
    const or = this.ofd(pipe, 'R', { end: 'r' }), ow = this.ofd(pipe, 'W', { end: 'w' });
    p.fds[r] = { ofd: or.id, cloexec };
    p.fds[w] = { ofd: ow.id, cloexec };
    ctx.desc = 'Creates pipe #' + pipe.num + ', a kernel buffer: fd ' + r + ' is its read end, fd ' + w + ' its write end. Bytes written on fd ' + w + ' can be read on fd ' + r + '.';
    ctx.hot.fds.push(r, w); ctx.hot.ofds.push(or.id, ow.id); ctx.hot.nodes.push(pipe.id);
  };

  H.socket = function (ev, p, ctx) {
    const s = this.node('socket', 'socket ' + (ev.args[0] || '').replace('AF_', ''));
    const o = this.ofd(s, 'RW');
    p.fds[ev.retn] = { ofd: o.id, cloexec: /SOCK_CLOEXEC/.test(ev.args[1] || '') };
    ctx.desc = 'Creates a ' + s.label + ' and returns fd ' + ev.retn + '.';
    ctx.hot.fds.push(ev.retn); ctx.hot.nodes.push(s.id);
  };
  H.socketpair = function (ev, p, ctx) {
    const [a, b] = intList(ev.args[3]);
    const s = this.node('socket', 'socketpair ' + (ev.args[0] || '').replace('AF_', ''));
    p.fds[a] = { ofd: this.ofd(s, 'RW').id, cloexec: false };
    p.fds[b] = { ofd: this.ofd(s, 'RW').id, cloexec: false };
    ctx.desc = 'Creates a pair of connected sockets: fds ' + a + ' and ' + b + '.';
    ctx.hot.fds.push(a, b);
  };

  H.clone = H.clone3 = H.fork = H.vfork = function (ev, p, ctx) {
    const child = String(ev.retn);
    if (isNaN(ev.retn)) return false;
    if (/CLONE_THREAD/.test(ev.argstr)) {
      this.S.tid[child] = p.pid;
      delete this.S.procs[child];
      ctx.desc = 'Creates thread ' + child + ' inside process ' + p.pid + ' (threads share the fd table).';
      return;
    }
    // the child may already be known if its first syscalls appeared earlier
    const existing = this.S.procs[child];
    const c = this.S.procs[child] = {
      pid: child, ppid: p.pid, bin: p.bin, argv: p.argv.slice(), status: 'running', code: null,
      fds: {}, order: existing ? existing.order : this.order++
    };
    for (const fd in p.fds) c.fds[fd] = Object.assign({}, p.fds[fd]);
    if (existing) Object.assign(c.fds, existing.fds);
    const fds = Object.keys(p.fds);
    ctx.desc = 'fork: process ' + p.pid + ' creates child ' + child + ' (fork returns ' + child + ' to the parent and 0 to the child). '
      + 'The child gets a copy of the fd table' + (fds.length ? ' (' + fds.join(', ') + '): each copied fd points to the same open file description as in the parent.' : '.');
    ctx.fx.push({ type: 'fork', parent: p.pid, child });
    ctx.hot.procs.push(child);
  };

  H.exit_group = H.exit = function (ev, p, ctx) {
    ctx.desc = 'Process ' + p.pid + ' asks the kernel to terminate with status ' + ev.args[0] + '.';
  };

  H.wait4 = H.waitpid = H.waitid = function (ev, p, ctx) {
    let child = ev.name === 'waitid' ? (/si_pid=(\d+)/.exec(ev.argstr) || [])[1] : String(ev.retn);
    const c = child && this.S.procs[child];
    if (!c) { ctx.desc = 'Waits for a child.'; return; }
    const code = c.code;
    this.reap(child);
    ctx.desc = 'Collects the exit status of child ' + child + ' (' + (typeof code === 'number' ? 'status ' + code : code) + '). The zombie is removed from the process table.';
  };

  H.kill = H.tgkill = function (ev, p, ctx) {
    ctx.desc = 'Sends ' + ev.args[ev.name === 'tgkill' ? 2 : 1] + ' to process ' + ev.args[ev.name === 'tgkill' ? 1 : 0] + '.';
  };

  // names of syscalls shown in "focus" mode even when they fail
  const RELEVANT = new Set(Object.keys(H));

  function simulate(events) {
    const sim = new Sim();
    sim.pipes = 0;
    const steps = [];
    let snap = null, root = null;
    const last = {};

    for (const ev of events) {
      if (root === null) root = ev.pid;
      const ctx = { desc: '', fx: [], hot: { fds: [], ofds: [], nodes: [], procs: [] }, dir: null };
      const known = !!sim.S.procs[sim.pidOf(ev.pid)];
      const p = sim.proc(ev.pid);
      let changed = !known;
      let relevant = true;

      if (ev.kind === 'syscall') {
        // failed execve() calls are usually the PATH search of execvp()
        relevant = RELEVANT.has(ev.name) && !(ev.err === 'ENOENT' && /^execve/.test(ev.name));
        if (ev.err) {
          ctx.desc = 'Fails with ' + ev.err + (ev.errmsg ? ' (' + ev.errmsg + ')' : '') + '.';
        } else if (H[ev.name]) {
          try {
            changed = H[ev.name].call(sim, ev, p, ctx) !== false || changed;
          } catch (e) {
            ctx.desc = 'Could not interpret this line (' + e.message + ').';
          }
        }
      } else if (ev.kind === 'signal') {
        ctx.desc = 'Process ' + p.pid + ' receives ' + ev.signal
          + (ev.signal === 'SIGCHLD' ? ': one of its children changed state (terminated).' : '.');
      } else if (ev.kind === 'exit') {
        ctx.desc = 'Process ' + p.pid + ' has terminated with status ' + ev.code + '.';
        sim.terminate(p, ev.code, ctx);
        changed = true;
      } else if (ev.kind === 'killed') {
        ctx.desc = 'Process ' + p.pid + ' is killed by ' + ev.signal + (ev.core ? ' (core dumped)' : '') + '.';
        sim.terminate(p, ev.signal, ctx);
        changed = true;
      }
      if (changed) { sim.gc(); snap = JSON.parse(JSON.stringify(sim.S)); }
      last[p.pid] = ev.i;
      steps.push({ ev, pid: p.pid, state: snap, last: Object.assign({}, last), desc: ctx.desc, fx: ctx.fx, hot: ctx.hot, dir: ctx.dir, relevant });
    }

    // first step of the program itself (after the dynamic loader)
    let mainStart = 0;
    const pr = steps.findIndex(s => s.ev.name === 'prlimit64' && /RLIMIT_STACK/.test(s.ev.argstr) && s.pid === root);
    if (pr >= 0) mainStart = pr + 1;
    else {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (s.pid !== root || (s.relevant && s.ev.name !== 'execve' && !touchesLoader(s))) break;
        if (touchesLoader(s)) mainStart = i + 1;
      }
    }
    // libraries loaded after an exec() in a child are loader steps too
    steps.forEach((s, i) => { s.loader = i < mainStart || touchesLoader(s); });
    return { steps, mainStart, root };

    function touchesLoader(s) {
      const path = /^(open|openat|openat2|creat)$/.test(s.ev.name) && s.ev.args.map(decodeStr).find(Boolean);
      if (path && LOADER_RE.test(path.text)) return true;
      const prev = steps[s.ev.i - 1];
      return [s.state, prev && prev.state].some(st => st && s.hot.nodes.some(id => st.nodes[id] && st.nodes[id].loader));
    }
  }

  const api = { parseTrace, simulate, splitArgs, decodeStr, show };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.XModel = api;
})(this);
