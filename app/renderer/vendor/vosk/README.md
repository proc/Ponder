# Vosk in the browser

`vosk.js` is `dist/vosk.js` from the npm package
[vosk-browser](https://github.com/ccoreilly/vosk-browser) 0.0.8 by Ciaran
O'Reilly: a WebAssembly build of the
[Vosk](https://alphacephei.com/vosk/) speech recogniser (Kaldi). Licensed
under the Apache License 2.0.

One change: the recogniser's worker, kept in `vosk.js` as base64 and started
from a blob, is `vosk-worker.js` here, unchanged, and `vosk.js` starts it from
that file. The worker builds functions at run time (Emscripten's Embind uses
`new Function`); a worker started from its own file is not bound by the
window's Content-Security-Policy, so the window itself still allows no eval.
And the worker keeps the unpacked model in memory rather than also caching it
in IndexedDB (two lines commented out, marked "Ponder"): Ponder keeps the
model on disk itself.

Ponder uses it for voice commands (`../../voice.js`). The English model it
reads, vosk-model-small-en-us-0.15 (Apache 2.0), is not kept here: Ponder
downloads it from alphacephei.com the first time voice commands are turned
on (`app/voice-model.js`).
