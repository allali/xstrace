/*
 * xstrace — view: renders a simulated step (see model.js) as HTML cards
 * connected by SVG wires, and animates the transitions between steps.
 */
(function () {
  'use strict';

  const M = window.XModel;
  const $ = s => document.querySelector(s);

  const EXAMPLES = [
    ['read', 'read() from stdin'],
    ['write', 'write() to stdout'],
    ['open_read', 'open a file and read it'],
    ['open_write', 'create a file and write it'],
    ['dup', 'dup(2)'],
    ['dup2', 'dup2(1, 3)'],
    ['pipe', 'create and close a pipe'],
    ['fork', 'fork + pipe: the child sends a file to its parent'],
    ['pipeline', 'what a shell does for echo hello | wc -c > out.txt']
  ];
  const ICON_PLAY = '<svg viewBox="0 0 16 16"><path d="M5 3v10l8-5z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 16 16"><path d="M4 3h3v10H4zM9 3h3v10H9z"/></svg>';
  const RAW_BASE = 'https://raw.githubusercontent.com/allali/xstrace/main/sample/';
  const SRC_BASE = 'https://github.com/allali/xstrace/blob/main/sample/';

  let T = null;          // { steps, mainStart, root, name }
  let cur = 0;           // index of the displayed step
  let anim = false;      // animate the current render?
  let playTimer = null;
  let pidColor = {};
  const wires = new Map(); // key -> svg path
  let wireLoop = 0;
  let packetRun = 0;
  let sel = null;          // selected fd: { pid, fd } (clicked in a fd table)

  const stage = $('#stage');
  const lists = { procs: $('#col-procs .list'), ofds: $('#col-ofds .list'), nodes: $('#col-nodes .list') };

  /* ------------------------------------------------------------------ */
  /* small helpers                                                       */
  /* ------------------------------------------------------------------ */

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function svg(tag, attrs) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function setText(el, t) { if (el.textContent !== String(t)) el.textContent = t; }
  const speed = () => +$('#speed').value;
  const focusOn = () => $('#focus').checked;
  const skipPostExecOn = () => $('#skip-post-exec').checked;
  function colorOf(pid) {
    const i = pidColor[pid] || 0;
    return 'hsl(' + ((218 + i * 137) % 360) + ' 62% 50%)';
  }
  function short(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function plural(n, w) { return n + ' ' + w + (n > 1 ? 's' : ''); }

  /* ------------------------------------------------------------------ */
  /* loading                                                             */
  /* ------------------------------------------------------------------ */

  function load(text, name) {
    stop();
    const events = M.parseTrace(text);
    if (!events.length) { alert('No syscall found in this file. Is it a strace log?'); return; }
    T = M.simulate(events);
    T.name = name;
    pidColor = {};
    sel = null;
    events.forEach(e => { if (!(e.pid in pidColor)) pidColor[e.pid] = Object.keys(pidColor).length; });

    // reset the stage
    Object.values(lists).forEach(l => (l.innerHTML = ''));
    $('#wire-layer').innerHTML = '';
    $('#packet-layer').innerHTML = '';
    wires.clear();

    setText($('#trace-name'), name.replace(/^x?strace$/, '') || 'strace');
    $('#scrub').max = T.steps.length - 1;
    buildTimeline();
    $('#intro').hidden = true;
    $('#viewer').hidden = false;
    go(firstIdx(), false);
  }

  function loadExample(name) {
    const get = url => fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); });
    get('sample/' + name + '.log')
      .catch(() => get(RAW_BASE + name + '.log'))
      .then(t => { history.replaceState(null, '', '#' + name); load(t, name + '.log'); })
      .catch(e => alert('Could not load example ' + name + ': ' + e.message));
  }

  function loadFile(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => { history.replaceState(null, '', location.pathname); load(r.result, file.name); };
    r.readAsText(file);
  }

  /* ------------------------------------------------------------------ */
  /* navigation                                                          */
  /* ------------------------------------------------------------------ */

  function shown(i) {
    const s = T.steps[i];
    if (skipPostExecOn() && s.postExec) return false;
    return !focusOn() || (s.relevant && !s.loader);
  }
  function firstIdx() { return focusOn() ? Math.max(0, T.mainStart - 1) : 0; }
  function nextIdx(i) {
    for (let j = i + 1; j < T.steps.length; j++) if (shown(j)) return j;
    return -1;
  }
  function prevIdx(i) {
    for (let j = i - 1; j >= 0; j--) if (shown(j)) return j;
    return i > firstIdx() ? firstIdx() : -1;
  }
  function lastIdx() {
    for (let j = T.steps.length - 1; j >= 0; j--) if (shown(j)) return j;
    return T.steps.length - 1;
  }

  function go(i, animate) {
    if (!T || i < 0 || i >= T.steps.length) return false;
    const forward = i === nextIdx(cur) || i === cur + 1;
    cur = i;
    anim = !!animate;
    render(anim && forward);
    return true;
  }
  const next = () => go(nextIdx(cur), true);
  const prev = () => go(prevIdx(cur), true);

  function play() {
    if (playTimer) return stop();
    if (nextIdx(cur) < 0) go(firstIdx(), false);
    $('#b-play').innerHTML = ICON_PAUSE;
    const tick = () => {
      if (!next()) return stop();
      const st = T.steps[cur];
      const busy = st.fx.some(f => f.type === 'flow' || f.type === 'fork');
      playTimer = setTimeout(tick, (busy ? 1400 : 850) / speed());
    };
    playTimer = setTimeout(tick, 120);
  }
  function stop() {
    clearTimeout(playTimer);
    playTimer = null;
    $('#b-play').innerHTML = ICON_PLAY;
  }

  /* ------------------------------------------------------------------ */
  /* keyed DOM reconciliation + FLIP animation                           */
  /* ------------------------------------------------------------------ */

  function sync(container, items, keyOf, create, update) {
    const existing = new Map();
    for (const el of container.children) if (el.dataset.key) existing.set(el.dataset.key, el);
    const keep = new Set();
    let prevEl = null;
    for (const item of items) {
      const k = keyOf(item);
      keep.add(k);
      let el = existing.get(k);
      if (!el) {
        el = create(item);
        el.dataset.key = k;
        if (anim) {
          el.classList.add('enter');
          el.addEventListener('animationend', () => el.classList.remove('enter'), { once: true });
        }
      }
      update(el, item);
      const ref = prevEl ? prevEl.nextSibling : container.firstChild;
      if (el !== ref) container.insertBefore(el, ref);
      prevEl = el;
    }
    for (const [k, el] of existing) if (!keep.has(k)) removeEl(el);
  }

  // removed elements fade out as absolutely positioned ghosts
  function removeEl(el) {
    if (anim) {
      const r = el.getBoundingClientRect(), s = stage.getBoundingClientRect();
      const g = el.cloneNode(true);
      g.removeAttribute('data-key');
      g.querySelectorAll('[data-key]').forEach(x => x.removeAttribute('data-key'));
      const pc = getComputedStyle(el).getPropertyValue('--pc');
      if (pc) g.style.setProperty('--pc', pc);
      g.classList.remove('enter', 'hot', 'sel', 'sel-main');
      g.classList.add('ghost-out');
      Object.assign(g.style, { left: r.left - s.left + 'px', top: r.top - s.top + 'px', width: r.width + 'px', height: r.height + 'px', transform: '' });
      $('#ghosts').appendChild(g);
      const done = () => g.remove();
      g.addEventListener('animationend', done, { once: true });
      setTimeout(done, 1000);
    }
    el.remove();
  }

  function keyed() { return stage.querySelectorAll('.col [data-key]'); }

  function snapshotRects() {
    const m = new Map();
    keyed().forEach(el => m.set(el.dataset.key, el.getBoundingClientRect()));
    keyed().forEach(el => { el.style.transition = 'none'; el.style.transform = ''; });
    return m;
  }

  function flip(old) {
    const els = [...keyed()];
    els.forEach(el => { el.style.transition = 'none'; el.style.transform = ''; });
    if (!anim) { els.forEach(el => (el.style.transition = '')); return; }
    const abs = new Map(), moved = [];
    for (const el of els) {             // document order: parents first
      const o = old.get(el.dataset.key);
      if (!o) continue;
      const n = el.getBoundingClientRect();
      const d = [o.left - n.left, o.top - n.top];
      abs.set(el, d);
      const parent = el.parentElement.closest('[data-key]');
      const pd = parent && abs.get(parent);
      const dx = d[0] - (pd ? pd[0] : 0), dy = d[1] - (pd ? pd[1] : 0);
      if (Math.abs(dx) < .5 && Math.abs(dy) < .5) continue;
      el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      moved.push(el);
    }
    void stage.offsetWidth;
    els.forEach(el => (el.style.transition = ''));
    moved.forEach(el => {
      el.style.transition = 'transform var(--t) cubic-bezier(.3,.7,.3,1)';
      el.style.transform = '';
    });
  }

  /* ------------------------------------------------------------------ */
  /* rendering of the three columns                                      */
  /* ------------------------------------------------------------------ */

  function fdLabel(S, f) {
    const o = S.ofds[f.ofd], n = o && S.nodes[o.node];
    if (!n) return '';
    if (n.kind === 'tty') return 'terminal' + (o.std ? ' (' + o.std + ')' : '');
    if (n.kind === 'pipe') return 'pipe #' + n.num + (o.end === 'r' ? ' read end' : ' write end');
    if (n.kind === 'file') return n.label.split('/').pop() || n.label;
    return n.label;
  }

  function renderProcs(S, st) {
    const procs = Object.values(S.procs).sort((a, b) => a.order - b.order);
    sync(lists.procs, procs, p => 'proc:' + p.pid, p => {
      const el = h('div', 'card proc');
      const head = h('div', 'proc-head');
      head.append(h('span', 'pid'), h('span', 'bin'), h('span', 'state'));
      const fdt = h('div', 'fdtable');
      const title = h('div', 'fdtable-title');
      title.append(h('span', '', 'fd table'), h('span', '', ''));
      fdt.append(title, h('div', 'rows'));
      el.append(head, h('div', 'proc-sub'), h('div', 'proc-last'), fdt);
      el.style.setProperty('--pc', colorOf(p.pid));
      return el;
    }, (el, p) => {
      setText(el.querySelector('.pid'), 'PID ' + p.pid);
      const bin = el.querySelector('.bin');
      if (bin.textContent !== p.bin) {
        if (anim && bin.textContent) { bin.classList.remove('flash'); void bin.offsetWidth; bin.classList.add('flash'); }
        bin.textContent = p.bin;
      }
      bin.title = p.bin;
      const state = el.querySelector('.state');
      state.className = 'state ' + p.status;
      setText(state, p.status === 'running' ? 'running'
        : p.status + ' (' + (typeof p.code === 'number' ? 'status ' + p.code : p.code) + ')');
      el.classList.toggle('dead', p.status !== 'running');
      el.classList.toggle('active', st.pid === p.pid);
      el.classList.toggle('hot', st.hot.procs.includes(p.pid) && st.pid !== p.pid);
      const sub = el.querySelector('.proc-sub');
      setText(sub, p.argv.join(' ') || ' ');
      sub.title = p.argv.join(' ');
      const li = st.last[p.pid];
      const last = el.querySelector('.proc-last');
      const lev = li !== undefined ? T.steps[li].ev : null;
      setText(last, lev ? (li === cur ? '▸ ' : '') + short(lev.raw, 80) : 'no syscall yet');
      last.title = lev ? lev.raw : '';
      last.classList.toggle('err', !!(lev && lev.err));

      const fds = Object.keys(p.fds).map(Number).sort((a, b) => a - b);
      setText(el.querySelector('.fdtable-title span:last-child'), fds.length ? plural(fds.length, 'open fd') : '');
      const rows = el.querySelector('.rows');
      sync(rows, fds, fd => 'fd:' + p.pid + ':' + fd, () => {
        const r = h('div', 'fd');
        r.append(h('span', 'num'), h('span', 'what'), h('span', 'tag', 'cloexec'), h('i', 'port'));
        return r;
      }, (r, fd) => {
        const f = p.fds[fd];
        setText(r.querySelector('.num'), fd);
        setText(r.querySelector('.what'), fdLabel(S, f));
        r.querySelector('.tag').hidden = !f.cloexec;
        r.dataset.ofd = f.ofd;
        r.classList.toggle('hot', st.pid === p.pid && st.hot.fds.includes(fd));
      });
      let empty = el.querySelector('.empty-fds');
      if (!fds.length && !empty) { empty = h('div', 'empty-fds', 'no open file descriptor'); rows.after(empty); }
      if (fds.length && empty) empty.remove();
    });
  }

  // kernel objects keep a fixed order: creation order (ids come from a single
  // increasing counter, and pipe() creates the read end before the write end)
  function kernelOrder(S) {
    const byId = (a, b) => +a.id.slice(1) - +b.id.slice(1);
    return { ofds: Object.values(S.ofds).sort(byId), nodes: Object.values(S.nodes).sort(byId) };
  }

  function renderOfds(S, st, ofds) {
    const refs = {};
    Object.values(S.procs).forEach(p => Object.values(p.fds).forEach(f => (refs[f.ofd] = (refs[f.ofd] || 0) + 1)));
    sync(lists.ofds, ofds, o => 'ofd:' + o.id, () => {
      const el = h('div', 'card ofd');
      el.append(h('i', 'port in'), h('span', 'mode'), h('span', 'off'), h('span', 'fl'), h('span', 'refs'), h('i', 'port out'));
      return el;
    }, (el, o) => {
      const n = S.nodes[o.node];
      const mode = el.querySelector('.mode');
      mode.className = 'mode ' + o.mode;
      setText(mode, o.mode);
      const off = el.querySelector('.off');
      if (n.kind === 'file') {
        if (!off.firstChild || off.firstChild.nodeType !== 3) { off.textContent = 'offset '; off.append(h('b')); }
        const b = off.querySelector('b');
        if (b.textContent !== String(o.offset)) {
          if (anim && b.textContent) { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
          b.textContent = o.offset;
        }
      } else setText(off, n.kind === 'pipe' ? (o.end === 'r' ? 'read end' : 'write end') : o.std || '');
      setText(el.querySelector('.fl'), [o.append && 'APPEND', o.flags].filter(Boolean).join(' ').replace(/\bAPPEND APPEND\b/, 'APPEND'));
      setText(el.querySelector('.refs'), refs[o.id] > 1 ? refs[o.id] + ' fds' : '1 fd');
      el.title = 'open file description: mode ' + o.mode + (n.kind === 'file' ? ', offset ' + o.offset : '') + ', used by ' + plural(refs[o.id] || 0, 'fd');
      el.classList.toggle('hot', st.hot.ofds.includes(o.id));
    });
  }

  function renderNodes(S, st, nodes) {
    sync(lists.nodes, nodes, n => 'node:' + n.id + ':' + n.kind, n => {
      const el = h('div', 'card node ' + n.kind);
      const head = h('div', 'node-head');
      head.append(h('span', 'kind', n.kind === 'file' && n.dir ? 'dir' : n.kind === 'tty' ? 'tty' : n.kind), h('span', 'node-name'), h('span', 'node-size'));
      el.append(head);
      if (n.kind === 'pipe') {
        const tube = h('div', 'pipe-tube');
        tube.append(h('span', '', 'buffer'), h('div', 'content'));
        const ends = h('div', 'pipe-ends');
        const w = h('div', 'pipe-end w', '⟶ write end'), r = h('div', 'pipe-end r', '⟵ read end');
        w.append(h('i', 'port'));
        r.append(h('i', 'port'));
        ends.append(r, w);
        el.append(ends, tube);
      } else {
        el.append(h('i', 'port in'), h('div', 'content'));
      }
      return el;
    }, (el, n) => {
      const name = el.querySelector('.node-name');
      const c = el.querySelector('.content');
      if (n.kind === 'pipe') {
        setText(name, '#' + n.num);
        setText(el.querySelector('.node-size'), n.content.length ? plural(n.content.length, 'byte') : 'empty');
        setText(c, M.show(n.content, 60));
        c.dataset.empty = 'empty';
      } else if (n.kind === 'tty') {
        setText(name, 'terminal');
        setText(el.querySelector('.node-size'), '');
        setText(c, n.content.split('\n').slice(-5).join('\n'));
        c.dataset.empty = 'output appears here';
      } else {
        setText(name, n.label);
        name.title = n.label;
        setText(el.querySelector('.node-size'), n.kind === 'file' && n.size ? '≥ ' + plural(n.size, 'byte') : '');
        setText(c, M.show(n.content, 140));
        c.dataset.empty = n.kind === 'file' ? 'contents unknown' : '';
        c.hidden = n.kind !== 'file' || !!n.dir;
      }
      el.classList.toggle('hot', st.hot.nodes.includes(n.id));
    });
  }

  /* ------------------------------------------------------------------ */
  /* selection: a clicked fd and everything it leads to                  */
  /* ------------------------------------------------------------------ */

  // keys of the elements and wires associated with the selected fd: the fd,
  // its open file description, the file / pipe, and the other fds sharing
  // that open file description
  function selection() {
    const out = { els: new Set(), wires: new Set() };
    if (!sel || !T) return out;
    const S = T.steps[cur].state, p = S.procs[sel.pid], f = p && p.fds[sel.fd];
    const o = f && S.ofds[f.ofd];
    if (!o) return out;
    out.els.add('ofd:' + o.id).add('node:' + o.node + ':' + S.nodes[o.node].kind);
    out.wires.add('ow:' + o.id);
    Object.values(S.procs).forEach(q => {
      for (const fd in q.fds) if (q.fds[fd].ofd === o.id) {
        out.els.add('fd:' + q.pid + ':' + fd);
        out.wires.add('fw:' + q.pid + ':' + fd + ':' + o.id);
      }
    });
    return out;
  }

  function applySelection() {
    const s = selection();
    stage.classList.toggle('has-sel', s.els.size > 0);
    keyed().forEach(el => {
      el.classList.toggle('sel', s.els.has(el.dataset.key));
      el.classList.toggle('sel-main', !!sel && el.dataset.key === 'fd:' + sel.pid + ':' + sel.fd && s.els.size > 0);
    });
    for (const [k, p] of wires) p.classList.toggle('sel', s.wires.has(k));
  }

  /* ------------------------------------------------------------------ */
  /* wires                                                               */
  /* ------------------------------------------------------------------ */

  function find(key) { return stage.querySelector('[data-key="' + key + '"]'); }

  function wireSpecs() {
    const st = T.steps[cur], S = st.state, out = [];
    const hotFd = new Set(st.hot.fds);
    Object.values(S.procs).forEach(p => {
      for (const fd in p.fds) {
        const f = p.fds[fd];
        const row = find('fd:' + p.pid + ':' + fd), o = find('ofd:' + f.ofd);
        if (!row || !o) continue;
        out.push({
          key: 'fw:' + p.pid + ':' + fd + ':' + f.ofd, a: row.querySelector('.port'), b: o.querySelector('.port.in'),
          cls: 'fdw', pc: colorOf(p.pid), hot: st.pid === p.pid && hotFd.has(+fd)
        });
      }
      if (p.ppid && S.procs[p.ppid]) {
        const a = find('proc:' + p.ppid), b = find('proc:' + p.pid);
        if (a && b) out.push({ key: 'kw:' + p.ppid + ':' + p.pid, a, b, cls: 'fork', fork: true, pc: colorOf(p.ppid) });
      }
    });
    Object.values(S.ofds).forEach(o => {
      const n = S.nodes[o.node];
      const el = find('ofd:' + o.id), ne = find('node:' + n.id + ':' + n.kind);
      if (!el || !ne) return;
      const port = n.kind === 'pipe' ? ne.querySelector('.pipe-end.' + (o.end || 'w') + ' .port') : ne.querySelector('.port.in');
      out.push({
        key: 'ow:' + o.id, a: el.querySelector('.port.out'), b: port, cls: 'ofdw',
        start: o.mode !== 'W', end: o.mode !== 'R',
        hot: st.hot.ofds.includes(o.id) && st.hot.nodes.includes(n.id)
      });
    });
    return out;
  }

  function center(el, s) {
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2 - s.left, r.top + r.height / 2 - s.top];
  }

  function drawWires(fresh) {
    if (!T) return;
    const s = stage.getBoundingClientRect();
    const svgEl = $('#wires');
    svgEl.setAttribute('width', stage.scrollWidth);
    svgEl.setAttribute('height', stage.scrollHeight);
    stage.style.setProperty('--kx', ($('#col-ofds').getBoundingClientRect().left - s.left - 36) + 'px');
    const layer = $('#wire-layer');
    const st = T.steps[cur];
    const keep = new Set();
    const selWires = selection().wires;
    for (const w of wireSpecs()) {
      keep.add(w.key);
      let d;
      if (w.fork) {
        const ra = w.a.getBoundingClientRect(), rb = w.b.getBoundingClientRect();
        const x1 = ra.left - s.left, y1 = ra.top - s.top + 16, x2 = rb.left - s.left, y2 = rb.top - s.top + 16;
        const bend = Math.min(40, 14 + Math.abs(y2 - y1) / 6);
        d = 'M' + x1 + ' ' + y1 + ' C' + (x1 - bend) + ' ' + y1 + ' ' + (x2 - bend) + ' ' + y2 + ' ' + (x2 - 2) + ' ' + y2;
      } else {
        const [x1, y1] = center(w.a, s), [x2, y2] = center(w.b, s);
        const c = Math.max(24, Math.abs(x2 - x1) * .5);
        d = 'M' + x1 + ' ' + y1 + ' C' + (x1 + c) + ' ' + y1 + ' ' + (x2 - c) + ' ' + y2 + ' ' + x2 + ' ' + y2;
      }
      let p = wires.get(w.key);
      if (!p || p.classList.contains('leaving')) {
        if (p) p.remove();
        p = svg('path', { class: 'wire ' + w.cls });
        if (w.pc) p.style.setProperty('--pc', w.pc);
        if (w.end || w.fork) p.setAttribute('marker-end', 'url(#arrow)');
        if (w.start) p.setAttribute('marker-start', 'url(#arrow)');
        layer.appendChild(p);
        wires.set(w.key, p);
        p.setAttribute('d', d);
        if (anim && fresh) {
          const len = p.getTotalLength();
          p.style.strokeDasharray = len;
          p.style.setProperty('--len', len);
          p.classList.add('draw');
          p.addEventListener('animationend', () => { p.classList.remove('draw'); p.style.strokeDasharray = ''; }, { once: true });
        }
      }
      if (p.getAttribute('d') !== d) p.setAttribute('d', d);
      p.classList.toggle('hot', !!w.hot);
      p.classList.toggle('in', !!w.hot && st.dir === 'in');
      p.classList.toggle('out', !!w.hot && st.dir === 'out');
      p.classList.toggle('sel', selWires.has(w.key));
    }
    for (const [k, p] of wires) {
      if (keep.has(k) || p.classList.contains('leaving')) continue;
      if (!anim) { p.remove(); wires.delete(k); continue; }
      p.classList.add('leaving');
      setTimeout(() => { if (wires.get(k) === p) { p.remove(); wires.delete(k); } }, 400);
    }
  }

  // redraw wires every frame while cards move
  function pumpWires(ms) {
    cancelAnimationFrame(wireLoop);
    drawWires(true);
    const end = performance.now() + ms;
    const loop = t => { drawWires(false); if (t < end) wireLoop = requestAnimationFrame(loop); };
    wireLoop = requestAnimationFrame(loop);
  }

  /* ------------------------------------------------------------------ */
  /* effects: data packets travelling along wires                        */
  /* ------------------------------------------------------------------ */

  function runFx(st) {
    const layer = $('#packet-layer');
    layer.innerHTML = '';
    const run = ++packetRun;
    st.fx.forEach(fx => {
      if (fx.type !== 'flow') return;
      const w1 = wires.get('fw:' + fx.pid + ':' + fx.fd + ':' + fx.ofd), w2 = wires.get('ow:' + fx.ofd);
      if (!w1 || !w2) return;
      const route = fx.dir === 'out' ? [[w1, false], [w2, false]] : [[w2, true], [w1, true]];
      const g = svg('g', { class: 'packet ' + fx.dir });
      const label = (fx.data ? '"' + M.show(fx.data, 12) + '" ' : '') + fx.n + ' B';
      const txt = svg('text', { x: 8, y: 4 });
      txt.textContent = label;
      const rect = svg('rect', { x: 0, y: -10, rx: 6, height: 20 });
      g.append(rect, txt);
      layer.appendChild(g);
      rect.setAttribute('width', txt.getComputedTextLength() + 16);
      const half = txt.getComputedTextLength() / 2 + 8;
      const dur = 1000 / speed(), t0 = performance.now() + 120 / speed();
      const frame = t => {
        if (run !== packetRun) return g.remove();
        let k = Math.min(1, Math.max(0, (t - t0) / dur));
        k = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        const lens = route.map(([p]) => p.getTotalLength());
        let d = k * (lens[0] + lens[1]), i = 0;
        if (d > lens[0]) { d -= lens[0]; i = 1; }
        const [p, rev] = route[i];
        const pt = p.getPointAtLength(rev ? lens[i] - d : d);
        g.setAttribute('transform', 'translate(' + (pt.x - half) + ',' + pt.y + ')');
        g.style.opacity = k >= 1 ? 0 : 1;
        if (k < 1) requestAnimationFrame(frame);
        else setTimeout(() => g.remove(), 200);
      };
      requestAnimationFrame(frame);
    });
  }

  /* ------------------------------------------------------------------ */
  /* side panel                                                          */
  /* ------------------------------------------------------------------ */

  function buildTimeline() {
    const ol = $('#timeline');
    ol.innerHTML = '';
    const frag = document.createDocumentFragment();
    T.steps.forEach((s, i) => {
      if (i === T.mainStart && i > 0) {
        frag.append(h('li', 'sep', '▼ main() — ' + plural(T.mainStart, 'syscall') + ' of the dynamic loader above'));
      }
      const li = h('li', (s.relevant ? '' : 'minor ') + (s.loader ? 'loader ' : '') + (s.postExec ? 'postexec ' : '') + (s.ev.err ? 'err' : ''));
      li.dataset.i = i;
      li.style.setProperty('--pc', colorOf(s.pid));
      li.append(h('span', 'dot'), h('span', 'txt', short(s.ev.raw, 140)));
      li.title = s.ev.raw;
      frag.append(li);
    });
    ol.append(frag);
    ol.classList.toggle('focus', focusOn());
    ol.classList.toggle('skip-post-exec', skipPostExecOn());
  }

  function renderSide(st) {
    const ev = st.ev;
    const chip = $('#now-pid');
    chip.style.setProperty('--pc', colorOf(st.pid));
    setText(chip, 'PID ' + st.pid);
    setText($('#now-step'), 'step ' + (cur + 1) + ' / ' + T.steps.length + (ev.line ? ' · line ' + ev.line : ''));
    const call = $('#now-call');
    call.innerHTML = '';
    const ret = $('#now-ret');
    ret.innerHTML = '';
    if (ev.kind === 'syscall') {
      call.append(h('span', 'name', ev.name), document.createTextNode('(' + short(ev.argstr, 400) + ')'));
      const r = h('span', ev.err ? 'ko' : 'ok', '= ' + ev.ret + (ev.err ? ' ' + ev.err + (ev.errmsg ? ' (' + ev.errmsg + ')' : '') : ''));
      ret.append(r);
    } else call.append(h('span', 'name', ev.raw));

    let desc = st.desc;
    if (focusOn() && st.loader && cur === T.mainStart - 1) {
      desc = 'The program is loaded: the dynamic loader ran ' + plural(T.mainStart, 'syscall') + ' (hidden in focus mode) to map the shared libraries. main() starts at the next step.';
    } else if (!desc) desc = st.relevant ? '' : 'This syscall does not change what is drawn here (memory management, metadata…).';
    setText($('#now-desc'), desc);
    if (anim && ev.err) { const n = $('#now'); n.classList.remove('shake'); void n.offsetWidth; n.classList.add('shake'); }

    const ol = $('#timeline');
    const old = ol.querySelector('li.cur');
    if (old) old.classList.remove('cur');
    const li = ol.querySelector('li[data-i="' + cur + '"]');
    if (li) { li.classList.add('cur'); li.scrollIntoView({ block: 'nearest' }); }
    $('#scrub').value = cur;
    setText($('#counter'), (cur + 1) + ' / ' + T.steps.length);
  }

  /* ------------------------------------------------------------------ */

  function render(fx) {
    const st = T.steps[cur], S = st.state;
    const rects = snapshotRects();
    const { ofds, nodes } = kernelOrder(S);
    renderProcs(S, st);
    renderOfds(S, st, ofds);
    renderNodes(S, st, nodes);
    flip(rects);
    if (!fx) { packetRun++; $('#packet-layer').innerHTML = ''; }
    pumpWires(anim ? 450 : 0);
    applySelection();
    renderSide(st);
    if (fx) runFx(st);
  }

  /* ------------------------------------------------------------------ */
  /* wiring of the UI                                                    */
  /* ------------------------------------------------------------------ */

  EXAMPLES.forEach(([name, what]) => {
    const b = h('button', 'example');
    b.append(h('b', '', name), h('span', '', what));
    const a = h('a', '', name + '.c');
    a.href = SRC_BASE + name + '.c';
    a.target = '_blank';
    a.addEventListener('click', e => e.stopPropagation());
    b.append(a);
    b.addEventListener('click', () => loadExample(name));
    $('#examples').append(b);
  });

  $('#file').addEventListener('change', e => loadFile(e.target.files[0]));
  const drop = $('#drop');
  document.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) drop.classList.remove('over'); });
  document.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    loadFile(e.dataTransfer.files[0]);
  });

  $('#home').addEventListener('click', () => {
    stop();
    $('#viewer').hidden = true;
    $('#intro').hidden = false;
    $('#file').value = '';
    history.replaceState(null, '', location.pathname);
  });
  $('#b-first').addEventListener('click', () => { stop(); go(firstIdx(), false); });
  $('#b-prev').addEventListener('click', () => { stop(); prev(); });
  $('#b-next').addEventListener('click', () => { stop(); next(); });
  $('#b-last').addEventListener('click', () => { stop(); go(lastIdx(), false); });
  $('#b-play').addEventListener('click', play);
  $('#b-main').addEventListener('click', () => { stop(); go(T.mainStart, true); });
  $('#scrub').addEventListener('input', e => { stop(); go(+e.target.value, false); });
  $('#focus').addEventListener('change', () => {
    $('#timeline').classList.toggle('focus', focusOn());
    if (T && !shown(cur) && cur !== firstIdx()) go(Math.max(firstIdx(), prevIdx(cur)), false);
  });
  $('#skip-post-exec').addEventListener('change', () => {
    $('#timeline').classList.toggle('skip-post-exec', skipPostExecOn());
    if (T && !shown(cur) && cur !== firstIdx()) go(Math.max(firstIdx(), prevIdx(cur)), false);
  });
  // click on a fd: highlight what it points to (click again / Esc to clear)
  stage.addEventListener('click', e => {
    const row = e.target.closest('.fd[data-key]');
    if (row) {
      const [, pid, fd] = row.dataset.key.split(':');
      sel = sel && sel.pid === pid && sel.fd === fd ? null : { pid, fd };
    } else if (!e.target.closest('.card')) sel = null;
    else return;
    applySelection();
  });

  $('#timeline').addEventListener('click', e => {
    const li = e.target.closest('li[data-i]');
    if (li) { stop(); go(+li.dataset.i, +li.dataset.i === nextIdx(cur)); }
  });

  document.addEventListener('keydown', e => {
    if ($('#viewer').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowRight' || k === ' ') { stop(); next(); }
    else if (k === 'ArrowLeft') { stop(); prev(); }
    else if (k === 'Home') { stop(); go(firstIdx(), false); }
    else if (k === 'End') { stop(); go(lastIdx(), false); }
    else if (k === 'p' || k === 'P') play();
    else if (k === 'Escape' && sel) { sel = null; applySelection(); }
    else return;
    e.preventDefault();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  });

  window.addEventListener('resize', () => drawWires(false));

  const hash = location.hash.slice(1);
  if (EXAMPLES.some(([n]) => n === hash)) loadExample(hash);
})();
