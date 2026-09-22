function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out`);
      error.status = 503;
      reject(error);
    }, milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function withoutLibraryStdout(fn) {
  const original = console.log;
  console.log = (...args) => console.error(...args);
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

export function createDrandLocker({ timeoutMs = 20_000 } = {}) {
  let modulePromise;
  let client;
  let chainInfo;

  async function context() {
    modulePromise ??= import('tlock-js');
    const library = await modulePromise;
    client ??= library.mainnetClient();
    chainInfo ??= await withTimeout(client.chain().info(), timeoutMs, 'drand chain info');
    return { library, client, chainInfo };
  }

  return {
    async lock(text, openAt) {
      const { library, client: drand, chainInfo: info } = await context();
      const round = library.roundAt(openAt.getTime(), info);
      const cipher = await withTimeout(
        library.timelockEncrypt(round, library.Buffer.from(text, 'utf8'), drand),
        timeoutMs,
        'drand encryption',
      );
      return { round, cipher };
    },

    async unlock(cipher) {
      const { library, client: drand } = await context();
      return withoutLibraryStdout(async () => {
        const plaintext = await withTimeout(
          library.timelockDecrypt(cipher, drand),
          timeoutMs,
          'drand decryption',
        );
        return plaintext.toString('utf8');
      });
    },
  };
}
