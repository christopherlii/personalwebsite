import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDictation } from '../public/dictation.js';
class Recognition {
  constructor() { Recognition.latest = this; }
  start() { this.onstart?.(); }
  stop() { this.stopped = true; }
  abort() { this.aborted = true; }
  result(text, index = 0, final = true) {
    const result = Object.assign([{ transcript: text }], { isFinal: final });
    this.onresult?.({ resultIndex: index, results: [...Array(index), result] });
  }
}
function setup(options = {}) {
  const states = [], messages = [], inserted = [];
  const controller = createDictation({ Recognition, language:'en-US', onState:(...value)=>states.push(value), onMessage:(...value)=>messages.push(value), ...options });
  const editor = { focus() {}, insertText(text) { inserted.push(text); return true; } };
  return { controller, editor, states, messages, inserted };
}
test('dictation starts only on request, inserts final phrases once, and flushes on stop', async () => {
  const { controller, editor, states, inserted } = setup();
  assert.equal(controller.owner, null);
  controller.toggle('composer', editor);
  const recognition = Recognition.latest;
  assert.equal(recognition.lang, 'en-US');
  recognition.result('draft words', 0, false); assert.deepEqual(inserted, []);
  recognition.result('some words'); recognition.result('some words');
  assert.deepEqual(inserted, ['some words']);
  const done = controller.stop();
  assert.equal(recognition.stopped, true);
  recognition.result('the last phrase', 1); recognition.onend(); await done;
  assert.deepEqual(inserted, ['some words', 'the last phrase']);
  assert.deepEqual(states.at(-1), ['composer','idle']);
});
test('cancel and switching editors reject late speech callbacks', () => {
  const { controller, editor, inserted } = setup();
  controller.toggle('composer', editor);
  const previous = Recognition.latest, late = previous.onresult;
  controller.toggle('reader', editor);
  assert.equal(previous.aborted, true);
  late({ resultIndex:0, results:[Object.assign([{transcript:'wrong note'}],{isFinal:true})] });
  assert.deepEqual(inserted, []); assert.equal(controller.owner,'reader');
  controller.cancel(); assert.equal(controller.owner,null);
});
test('permission errors and unsupported browsers preserve existing text', () => {
  const { controller, editor, messages, inserted } = setup();
  controller.toggle('composer', editor);
  Recognition.latest.onerror({error:'not-allowed'});
  assert.match(messages.at(-1)[1], /Microphone access was denied/);
  assert.equal(controller.owner,null); assert.deepEqual(inserted, []);
  const unsupported=setup({Recognition:null}); unsupported.controller.toggle('composer',unsupported.editor);
  assert.match(unsupported.messages.at(-1)[1], /isn’t supported/);
});
test('an editor limit stops dictation without inserting an overflow', () => {
  const {controller,states}=setup(); controller.toggle('reader',{focus(){},insertText(){return false;}});
  const recognition=Recognition.latest; recognition.result('too much');
  assert.equal(recognition.aborted,true); assert.deepEqual(states.at(-1),['reader','idle']);
});
