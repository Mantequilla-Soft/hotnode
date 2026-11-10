const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
require('./helpers');
const { DiscordNotifier } = require('../../utils/discord');

const CUSTOM = 'https://discord.test/custom';
const DEFAULT = 'https://discord.test/default';

let posts;

beforeEach(() => {
  posts = [];
  mock.method(axios, 'post', async (url, payload) => { posts.push({ url, payload }); });
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
});
afterEach(() => mock.restoreAll());

describe('send', () => {
  test('posts one embed to both webhooks', async () => {
    const d = new DiscordNotifier(CUSTOM, DEFAULT);
    await d.send('Title', 'Body', 'red', [{ name: 'k', value: 'v' }]);

    assert.deepEqual(posts.map(p => p.url).sort(), [CUSTOM, DEFAULT]);
    const [embed] = posts[0].payload.embeds;
    assert.equal(embed.title, 'Title');
    assert.equal(embed.description, 'Body');
    assert.equal(embed.color, 15158332);
    assert.deepEqual(embed.fields, [{ name: 'k', value: 'v' }]);
  });

  test('defaultOnly skips the custom webhook', async () => {
    const d = new DiscordNotifier(CUSTOM, DEFAULT);
    await d.send('Title', 'Body', 'blue', [], true);
    assert.deepEqual(posts.map(p => p.url), [DEFAULT]);
  });

  test('no webhooks configured: nothing is posted', async () => {
    const saved = { c: process.env.DISCORD_WEBHOOK_URL, d: process.env.DEFAULT_WEBHOOK_URL };
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DEFAULT_WEBHOOK_URL;
    try {
      const d = new DiscordNotifier('', '');
      assert.ok(!d.isEnabled());
      await d.send('Title', 'Body');
      assert.equal(posts.length, 0);
    } finally {
      if (saved.c !== undefined) process.env.DISCORD_WEBHOOK_URL = saved.c;
      if (saved.d !== undefined) process.env.DEFAULT_WEBHOOK_URL = saved.d;
    }
  });

  test('a failing webhook does not throw or block the other', async () => {
    mock.restoreAll();
    mock.method(console, 'error', () => {});
    mock.method(console, 'log', () => {});
    mock.method(axios, 'post', async (url) => {
      if (url === CUSTOM) throw new Error('429');
      posts.push({ url });
    });
    const d = new DiscordNotifier(CUSTOM, DEFAULT);
    await d.send('Title', 'Body');
    assert.deepEqual(posts.map(p => p.url), [DEFAULT]);
  });
});

describe('notifyOverduePins', () => {
  test('includes repo usage and says ingestion continues', async () => {
    const d = new DiscordNotifier(CUSTOM, '');
    const sent = mock.method(d, 'send', async () => {});
    await d.notifyOverduePins(213, 12, 34);

    const [title, message, color, fields] = sent.mock.calls[0].arguments;
    assert.equal(title, '🚨 Overdue Pins Detected');
    assert.match(message, /213 pins/);
    assert.match(message, /Ingestion continues/);
    assert.equal(color, 'red');
    assert.deepEqual(fields, [
      { name: 'Overdue Count', value: '213', inline: true },
      { name: 'Oldest Pin Age', value: '12 days', inline: true },
      { name: 'Repo Usage', value: '34%', inline: true }
    ]);
  });

  test('omits repo usage when unknown', async () => {
    const d = new DiscordNotifier(CUSTOM, '');
    const sent = mock.method(d, 'send', async () => {});
    await d.notifyOverduePins(5, 9);
    const fields = sent.mock.calls[0].arguments[3];
    assert.deepEqual(fields.map(f => f.name), ['Overdue Count', 'Oldest Pin Age']);
  });

  test('goes to the custom webhook too (not default-only)', async () => {
    const d = new DiscordNotifier(CUSTOM, DEFAULT);
    await d.notifyOverduePins(5, 9, 40);
    assert.deepEqual(posts.map(p => p.url).sort(), [CUSTOM, DEFAULT]);
  });
});
