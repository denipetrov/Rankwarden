import { describe, expect, it } from 'vitest';

import { currentRunId, runTag, withRunId } from './run-context.js';

describe('withRunId', () => {
  it('has no run outside one', () => {
    expect(currentRunId()).toBeUndefined();
    expect(runTag()).toBe('');
  });

  it('exposes the id it hands the callback', async () => {
    const seen = await withRunId('sweep', async (id) => ({ id, inner: currentRunId() }));

    expect(seen.inner).toBe(seen.id);
  });

  it('reaches code it did not pass the id to', async () => {
    // Async local storage, so a repository several awaits deep still stamps its
    // lines without every signature having to carry a parameter.
    const nested = async () => {
      await Promise.resolve();
      return currentRunId();
    };

    const [id, deep] = await withRunId('sweep', async (runId) => [runId, await nested()]);

    expect(deep).toBe(id);
  });

  it('tags a line with the kind and the id', async () => {
    const tag = await withRunId('enrich', async () => runTag());

    expect(tag).toMatch(/^\[enrich [0-9a-z]{6}\] $/);
  });

  it('gives concurrent runs different ids', async () => {
    const [first, second] = await Promise.all([
      withRunId('sweep', async (id) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        // Still its own id after yielding to the other run.
        expect(currentRunId()).toBe(id);
        return id;
      }),
      withRunId('sweep', async (id) => id),
    ]);

    expect(first).not.toBe(second);
  });

  it('clears the context once the run finishes', async () => {
    await withRunId('archive', async () => undefined);

    expect(currentRunId()).toBeUndefined();
  });

  it('clears the context when the run throws', async () => {
    await expect(
      withRunId('snapshot', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(currentRunId()).toBeUndefined();
  });
});
