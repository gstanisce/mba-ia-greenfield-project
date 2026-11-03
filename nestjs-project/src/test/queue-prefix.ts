// Runs before each Jest file, after dotenv. It overrides QUEUE_PREFIX from .env so the
// suites keep their queue keys under "test:", where the running video-worker never looks.
process.env.QUEUE_PREFIX = 'test';
