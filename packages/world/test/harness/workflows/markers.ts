import { createHook, FatalError, getWritable } from "workflow";

const mark = (n: number, nonce: string) => `OSMARK${n}_${nonce}`;

export async function markers(input: { nonce: string; m1: string }) {
  "use workflow";
  const { nonce } = input;
  const m3 = await echoStep(mark(2, nonce), nonce);
  // M6 and M8 are built inside the steps so they reach storage only as a
  // stream chunk and as error text, never as a step argument.
  await streamStep(getWritable<string>(), nonce);
  let m8 = "";
  try {
    await failingStep(nonce);
  } catch (err) {
    m8 = (err as Error).message;
  }
  const hook = createHook<{ m5: string }>({
    token: `tok-${nonce}`,
    metadata: { m4: mark(4, nonce) },
  });
  const payload = await hook;
  return { m7: mark(7, nonce), m1: input.m1, m3, m5: payload.m5, m8 };
}

async function echoStep(m2: string, nonce: string) {
  "use step";
  return `${m2 === `OSMARK2_${nonce}` ? "OSMARK3" : "BAD"}_${nonce}`;
}

async function streamStep(writable: WritableStream<string>, nonce: string) {
  "use step";
  const writer = writable.getWriter();
  await writer.write(`OSMARK6_${nonce}`);
  writer.releaseLock();
}

async function failingStep(nonce: string) {
  "use step";
  throw new FatalError(`OSMARK8_${nonce}`);
}
