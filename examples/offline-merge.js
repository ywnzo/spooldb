import { Engine } from '../src/index.js';
import { randomUUID } from 'node:crypto';

const laptop = new Engine(); const runner = new Engine();
const submit = (engine, actor, operations) => engine.submit('main', {
  actor, harness: actor === 'developer' ? 'terminal' : 'generic-agent', requestId: randomUUID(),
  expectedHeads: engine.read('main').heads, operations,
});
try {
  laptop.create();
  submit(laptop, 'developer', [{ type: 'file.create', fileId: 'greeting', path: 'hello.js', text: 'hello world' }]);
  const anchor = laptop.anchor('main', 'greeting', 6, 11);
  runner.import('main', laptop.export('main'));
  submit(laptop, 'developer', [{ type: 'file.splice', fileId: 'greeting', index: 0, deleteCount: 0, insert: 'local ' }]);
  submit(runner, 'agent', [
    { type: 'file.splice', fileId: 'greeting', index: 11, deleteCount: 0, insert: '!' },
    { type: 'message.add', messageId: 'reply-1', role: 'assistant', text: 'Added enthusiasm.' },
  ]);
  const outgoing = laptop.export('main'); laptop.import('main', runner.export('main')); runner.import('main', outgoing);
  console.log(JSON.stringify({ converged: JSON.stringify(laptop.read('main')) === JSON.stringify(runner.read('main')),
    file: laptop.read('main').files[0], anchor: laptop.resolve('main', anchor),
    history: laptop.history('main') }, null, 2));
} finally { laptop.close(); runner.close(); }
