import type { SseEvent } from './types.js';

const LINE_BREAK = /\r\n|\n|\r/;
const BOM = '﻿';

export async function* parseSse(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<SseEvent<string>> {
  const decoder = new TextDecoder();

  let buffer = '';
  let started = false;
  let eventName = '';
  let data: string[] = [];
  let lastId: string | undefined;
  let retry: number | undefined;

  const dispatch = (): SseEvent<string> | undefined => {
    if (data.length === 0) {
      eventName = '';

      return undefined;
    }

    const event: SseEvent<string> = {
      event: eventName || 'message',
      data: data.join('\n'),
      ...(lastId !== undefined && { id: lastId }),
      ...(retry !== undefined && { retry }),
    };

    eventName = '';
    data = [];

    return event;
  };

  const readField = (line: string) => {
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? '' : line.slice(colon + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    if (field === 'event') eventName = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) lastId = value;
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
  };

  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

    if (!started && buffer.length > 0) {
      started = true;

      if (buffer.startsWith(BOM)) buffer = buffer.slice(1);
    }

    // a trailing \r may be the first half of \r\n that arrives in the next chunk
    const hold = buffer.endsWith('\r') ? '\r' : '';
    const lines = buffer.slice(0, buffer.length - hold.length).split(LINE_BREAK);

    buffer = lines.pop()! + hold;

    for (const line of lines) {
      if (line === '') {
        const event = dispatch();

        if (event) yield event;
      } else if (!line.startsWith(':')) {
        readField(line);
      }
    }
  }
}
