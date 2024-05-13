import {v4} from 'uuid';

// Default to a dummy "batch" implementation that just runs the callback
export function defaultNoopBatch(callback: () => void) {
  const channel = new MessageChannel();

  const timeoutMessageName = `timeout-${v4()}`;

  function handleMessage(event: MessageEvent) {
    if (event.data === timeoutMessageName) {
      event.stopPropagation();
      callback();
      channel.port1.close();
      channel.port2.close();
    }
  }

  channel.port1.onmessage = handleMessage;
  channel.port2.postMessage(timeoutMessageName);
}
