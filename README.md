# Breathwork Round and Hold Timer

Time your Breathwork rounds and breath holds. Set your rounds, breathe, and we keep the count.

A single web page that times round-based Breathwork practice. There are no accounts, no server, no analytics and no tracking. It loads no outside scripts or fonts, so once the page is open it keeps working without a connection.

## What it does

Each round has three parts:

1. **Breathe.** A breath counter and a pulsing circle set the pace (default 30 breaths, one every 2 seconds). Turn off steady pace and you can tap the circle for each breath instead, with a Pause button on screen.
2. **Hold.** A big stopwatch counts up from zero until you tap End hold or press the space bar.
3. **Recovery hold.** Breathe in fully and hold while a countdown runs (default 15 seconds).

Then the next round starts on its own. At the end you see each hold time (Round 1: 1:12, Round 2: 1:31, and so on).

Also included:

- History of past sessions, kept only in your browser (localStorage), with a Clear history button
- Optional soft tones at each phase change, generated in the browser and off by default
- Keeps the screen awake during a session, in browsers that support the Screen Wake Lock API
- Big tap targets for one-handed phone use, plus keyboard control: Space starts, pauses, resumes and ends a hold, and P pauses
- No pulsing for people who set their device to reduce motion
- Stays in Liquid Breathwork navy whether your device is set to light or dark mode

## How to use it

1. Set your rounds, breaths per round and recovery hold. Keep steady pace on to follow the circle, or turn it off and tap the circle for each breath.
2. Press Start and breathe with the count. After the last breath, breathe out and hold while the stopwatch runs.
3. When you need to breathe in, tap End hold or press the space bar. Breathe in fully and hold until the countdown ends.
4. The next round starts on its own. At the end we show each hold time and keep it in this browser only.

## Safety

Sit or lie down somewhere safe. Do not practice strong breath holds while driving, in or near water, standing, or anywhere fainting would be dangerous. Chest pressure, dizziness, or sharp air hunger means stop and breathe normally. If you are pregnant or have a heart condition or epilepsy, talk with your doctor before practicing breath holds.

## Run it locally

Download or clone this repository and open `index.html` in a browser. There is no build step and nothing to install.

## Tests

The timing logic lives in `timer-core.js`. The page and the tests both load that file. To run the tests (checked with Node.js 24):

```sh
npm test
```

This runs `node --test` with no dependencies. The tests cover round sequencing, the hold stopwatch, the recovery countdown, pause and resume, and the results history.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The timer page, with its styles and page script inline |
| `timer-core.js` | Phase and timer logic, plus the history helpers |
| `test/timer-core.test.js` | Tests for `timer-core.js` using `node:test` |
| `LICENSE` | MIT license |

## Credit

Made by [Liquid Breathwork](https://www.liquidbreathwork.com/), a Breathwork practice in Arizona. Learn to guide sessions in our [Breathwork certification](https://www.liquidbreathwork.com/breathwork-certification/).

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Liquid Breathwork.
