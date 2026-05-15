#!/usr/bin/env node
// Fake `claude` binary used by interactive-session.test.js.
//
// Mimics the real CLI's input contract just enough for the tests:
//   - Reads from stdin in bracketed-paste mode (ESC[200~ ... ESC[201~ <pause> \r)
//   - When it receives a complete submitted message, writes a `user`, an
//     `assistant`, and a `result` event as JSONL to the file at
//     $TRANSCRIPT_PATH (matching the shape of claude's real transcript)
//   - `/exit` terminates the process
//   - The special message `__prompt__` writes a yes/no prompt to stdout to
//     exercise prompt-detector tests (Phase 3)

import fs from 'node:fs';

const TX = process.env.TRANSCRIPT_PATH;
if (!TX) {
  console.error('stub-claude: TRANSCRIPT_PATH env var is required');
  process.exit(2);
}

function emit(event) {
  fs.appendFileSync(TX, JSON.stringify(event) + '\n');
}

// Render an initial fake prompt line so the PTY has something to show.
process.stdout.write('> ');

let pasteBuf = '';      // accumulated content of the most recent paste
let pendingSubmit = ''; // pasted content waiting for the user's Enter
let inPaste = false;

function consume(text) {
  if (text === '/exit') {
    process.exit(0);
  }
  if (text === '__prompt__') {
    process.stdout.write('\nContinue with this action? [y/N] ');
    return;
  }
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  const reply = `echo: ${text}`;
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
  emit({ type: 'result', subtype: 'success' });
  process.stdout.write(`\n${reply}\n> `);
}

process.stdin.on('data', chunk => {
  const s = chunk.toString();
  let i = 0;
  while (i < s.length) {
    // Bracketed-paste start
    if (s.slice(i, i + 6) === '\x1b[200~') {
      inPaste = true;
      pasteBuf = '';
      i += 6;
      continue;
    }
    // Bracketed-paste end — stash content; wait for a separate Enter to submit
    if (s.slice(i, i + 6) === '\x1b[201~') {
      inPaste = false;
      pendingSubmit = pasteBuf;
      pasteBuf = '';
      i += 6;
      continue;
    }
    const ch = s[i];
    if (inPaste) {
      pasteBuf += ch;
      i += 1;
      continue;
    }
    // Outside paste: Enter (CR) submits the pending paste, OR if no paste is
    // pending, submits the line typed character-by-character (single-byte path
    // — useful for short prompt answers like 'y').
    if (ch === '\r' || ch === '\n') {
      const text = pendingSubmit || pasteBuf;
      pendingSubmit = '';
      pasteBuf = '';
      if (text) consume(text);
      i += 1;
      continue;
    }
    // Otherwise treat as user typing.
    pasteBuf += ch;
    i += 1;
  }
});

// Ctrl+C → exit cleanly
process.on('SIGINT', () => process.exit(0));
