import "@testing-library/jest-dom/vitest"

(function mockMessageChannel() {
  const MessageChannel = function () {
    let onmessage: Function;
    return {
      port1: {
        set onmessage(cb: Function) {
          onmessage = cb;
        },
        close: () => ({})
      },
      port2: {
        postMessage: (data: unknown) => {
          const stopPropagation = () => ({});

          onmessage?.({ data, stopPropagation });
        },
        close: () => ({})
      },
    };
  };

  global.MessageChannel = MessageChannel as unknown as typeof global.MessageChannel;
})();
