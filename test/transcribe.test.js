import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track execFile calls for assertions
const execFileCalls = [];

// Mock child_process with custom promisify support
vi.mock('child_process', () => {
  const fn = vi.fn();
  // Node's promisify uses this symbol for execFile to return { stdout, stderr }
  fn[Symbol.for('nodejs.util.promisify.custom')] = vi.fn();
  return { execFile: fn };
});

// Mock fs
vi.mock('fs', () => ({
  default: {
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

import { execFile } from 'child_process';
import fs from 'fs';
import { transcribeAudio, MIME_TO_EXT } from '../lib/transcribe.js';

function mockExecFile(ffmpegResult, whisperResult) {
  const customFn = execFile[Symbol.for('nodejs.util.promisify.custom')];
  customFn.mockImplementation((cmd, args, opts) => {
    execFileCalls.push({ cmd, args, opts });
    if (cmd === 'ffmpeg') {
      if (ffmpegResult?.error) return Promise.reject(ffmpegResult.error);
      return Promise.resolve({ stdout: ffmpegResult?.stdout || '', stderr: ffmpegResult?.stderr || '' });
    } else if (cmd.includes('whisper-cli')) {
      if (whisperResult?.error) return Promise.reject(whisperResult.error);
      return Promise.resolve({ stdout: whisperResult?.stdout || '', stderr: whisperResult?.stderr || '' });
    }
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });
}

const CONFIG = {
  modelPath: '/opt/whisper/models/ggml-small.bin',
  language: 'en',
};

describe('MIME_TO_EXT', () => {
  it('maps common voice note MIME types', () => {
    expect(MIME_TO_EXT['audio/ogg']).toBe('.ogg');
    expect(MIME_TO_EXT['audio/opus']).toBe('.opus');
    expect(MIME_TO_EXT['audio/mp4']).toBe('.m4a');
    expect(MIME_TO_EXT['audio/mpeg']).toBe('.mp3');
    expect(MIME_TO_EXT['audio/wav']).toBe('.wav');
    expect(MIME_TO_EXT['audio/webm']).toBe('.webm');
    expect(MIME_TO_EXT['audio/aac']).toBe('.aac');
    expect(MIME_TO_EXT['audio/x-caf']).toBe('.caf');
  });
});

describe('transcribeAudio', () => {
  const fakeBuffer = Buffer.from('fake audio data');

  beforeEach(() => {
    vi.clearAllMocks();
    execFileCalls.length = 0;
  });

  it('returns transcribed text', async () => {
    mockExecFile(
      { stdout: '', stderr: '' },
      { stdout: 'Hello, this is a test.' },
    );

    const result = await transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG);
    expect(result).toBe('Hello, this is a test.');
  });

  it('strips whisper timestamp brackets from output', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: '[00:00:00.000 --> 00:00:03.000]  Hello world.\n[00:00:03.000 --> 00:00:05.000]  Testing.' },
    );

    const result = await transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG);
    expect(result).toBe('Hello world.\n  Testing.');
  });

  it('throws on empty transcription', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: '   \n  ' },
    );

    await expect(transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG))
      .rejects.toThrow('empty transcription result');
  });

  it('passes correct ffmpeg args for 16kHz mono WAV conversion', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'transcribed text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG);

    const ffmpegCall = execFileCalls.find(c => c.cmd === 'ffmpeg');
    expect(ffmpegCall).toBeDefined();
    expect(ffmpegCall.args).toContain('-ar');
    expect(ffmpegCall.args).toContain('16000');
    expect(ffmpegCall.args).toContain('-ac');
    expect(ffmpegCall.args).toContain('1');
    expect(ffmpegCall.args).toContain('-f');
    expect(ffmpegCall.args).toContain('wav');
    expect(ffmpegCall.args).toContain('-y');
  });

  it('passes correct whisper-cli args', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'transcribed text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG);

    const whisperCall = execFileCalls.find(c => c.cmd.includes('whisper-cli'));
    expect(whisperCall).toBeDefined();
    expect(whisperCall.args).toContain('-m');
    expect(whisperCall.args).toContain(CONFIG.modelPath);
    expect(whisperCall.args).toContain('--no-timestamps');
    expect(whisperCall.args).toContain('-l');
    expect(whisperCall.args).toContain('en');
  });

  it('derives whisper-cli path from modelPath', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG);

    const whisperCall = execFileCalls.find(c => c.cmd.includes('whisper-cli'));
    expect(whisperCall.cmd).toBe('/opt/whisper/build/bin/whisper-cli');
  });

  it('uses correct file extension from MIME type', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/mp4', CONFIG);

    const ffmpegCall = execFileCalls.find(c => c.cmd === 'ffmpeg');
    const inputArg = ffmpegCall.args[ffmpegCall.args.indexOf('-i') + 1];
    expect(inputArg).toMatch(/\.m4a$/);
  });

  it('falls back to .ogg for unknown MIME types', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/unknown-format', CONFIG);

    const ffmpegCall = execFileCalls.find(c => c.cmd === 'ffmpeg');
    const inputArg = ffmpegCall.args[ffmpegCall.args.indexOf('-i') + 1];
    expect(inputArg).toMatch(/\.ogg$/);
  });

  it('writes buffer to temp file', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(fs.writeFileSync.mock.calls[0][1]).toBe(fakeBuffer);
  });

  it('cleans up temp files on success', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG);

    expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
  });

  it('cleans up temp files on ffmpeg error', async () => {
    mockExecFile(
      { error: new Error('ffmpeg failed') },
      { stdout: '' },
    );

    await expect(transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG))
      .rejects.toThrow('ffmpeg failed');

    expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
  });

  it('cleans up temp files on whisper error', async () => {
    mockExecFile(
      { stdout: '' },
      { error: new Error('whisper crashed') },
    );

    await expect(transcribeAudio(fakeBuffer, 'audio/ogg', CONFIG))
      .rejects.toThrow('whisper crashed');

    expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
  });

  it('respects custom language config', async () => {
    mockExecFile(
      { stdout: '' },
      { stdout: 'transcribed text' },
    );

    await transcribeAudio(fakeBuffer, 'audio/ogg', { ...CONFIG, language: 'de' });

    const whisperCall = execFileCalls.find(c => c.cmd.includes('whisper-cli'));
    expect(whisperCall.args).toContain('de');
  });
});
