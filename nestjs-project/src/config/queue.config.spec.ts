import queueConfig from './queue.config';

describe('queueConfig', () => {
  const originalPrefix = process.env.QUEUE_PREFIX;

  afterEach(() => {
    if (originalPrefix === undefined) {
      delete process.env.QUEUE_PREFIX;
    } else {
      process.env.QUEUE_PREFIX = originalPrefix;
    }
  });

  it('should default the BullMQ prefix to "bull" when QUEUE_PREFIX is unset', () => {
    delete process.env.QUEUE_PREFIX;

    expect(queueConfig().prefix).toBe('bull');
  });

  it('should use QUEUE_PREFIX when it is set', () => {
    process.env.QUEUE_PREFIX = 'test';

    expect(queueConfig().prefix).toBe('test');
  });
});
