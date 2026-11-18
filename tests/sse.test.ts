import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseSse } from '../src/sse.js';
import type { SseEvent } from '../src/types.js';

const parse = async (...chunks: (string | Uint8Array)[]) => {
  const events: SseEvent<string>[] = [];

  for await (const item of parseSse((async function* () {
    yield* chunks;
  })())) {
    events.push(item);
  }

  return events;
};

describe('parseSse', () => {
  it('should parse an event with the default name if only data is sent', async () => {
    assert.deepEqual(await parse('data: hello\n\n'), [{ event: 'message', data: 'hello' }]);
  });

  it('should use the event name if the event field is sent', async () => {
    assert.deepEqual(await parse('event: update\ndata: 1\n\n'), [{ event: 'update', data: '1' }]);
  });

  it('should join data lines with a newline if an event has several', async () => {
    assert.deepEqual(await parse('data: a\ndata: b\n\n'), [{ event: 'message', data: 'a\nb' }]);
  });

  it('should keep the id and the retry for the following events if they were sent once', async () => {
    const events = await parse('id: 7\nretry: 1500\ndata: a\n\ndata: b\n\n');

    assert.deepEqual(events, [
      { event: 'message', data: 'a', id: '7', retry: 1500 },
      { event: 'message', data: 'b', id: '7', retry: 1500 },
    ]);
  });

  it('should ignore a retry that is not a number or an id with a null character', async () => {
    assert.deepEqual(await parse('retry: soon\nid: a\0b\ndata: x\n\n'), [{ event: 'message', data: 'x' }]);
  });

  it('should ignore comments and unknown fields if they are sent', async () => {
    assert.deepEqual(await parse(': keep-alive\nfoo: bar\ndata: x\n\n'), [{ event: 'message', data: 'x' }]);
  });

  it('should treat a line without a colon as a field with an empty value if it is sent', async () => {
    assert.deepEqual(await parse('data\n\n'), [{ event: 'message', data: '' }]);
  });

  it('should not dispatch an event without data and should reset its name if the block has no data', async () => {
    assert.deepEqual(await parse('event: ping\n\ndata: x\n\n'), [{ event: 'message', data: 'x' }]);
  });

  it('should strip only the first space of a value if the value has several', async () => {
    assert.deepEqual(await parse('data:  two\n\n'), [{ event: 'message', data: ' two' }]);
  });

  it('should support all line endings if \\r\\n, \\r and \\n are mixed', async () => {
    const events = await parse('data: a\r\n\r\ndata: b\r\rdata: c\n\n');

    assert.deepEqual(events.map(item => item.data), ['a', 'b', 'c']);
  });

  it('should join an event split across chunks if a line is cut in the middle', async () => {
    assert.deepEqual(await parse('da', 'ta: hel', 'lo\n', '\n'), [{ event: 'message', data: 'hello' }]);
  });

  it('should not split an event if \\r\\n is cut between chunks', async () => {
    const events = await parse('data: a\r', '\ndata: b\r\n\r\n');

    assert.deepEqual(events, [{ event: 'message', data: 'a\nb' }]);
  });

  it('should decode a multibyte character split across chunks if bytes are passed', async () => {
    const bytes = new TextEncoder().encode('data: привет\n\n');

    assert.deepEqual(await parse(bytes.slice(0, 9), bytes.slice(9)), [{ event: 'message', data: 'привет' }]);
  });

  it('should drop a leading BOM if the stream starts with one', async () => {
    assert.deepEqual(await parse('﻿data: x\n\n'), [{ event: 'message', data: 'x' }]);
  });

  it('should discard an event that is not terminated by a blank line if the stream ends', async () => {
    assert.deepEqual(await parse('data: a\n\ndata: b\n'), [{ event: 'message', data: 'a' }]);
  });

  it('should yield nothing if the stream is empty', async () => {
    assert.deepEqual(await parse(), []);
    assert.deepEqual(await parse(''), []);
  });
});
