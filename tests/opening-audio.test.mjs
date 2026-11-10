import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareOpeningAudio } from "../src/opening-audio.js";

class AudioFixture extends EventTarget {
  readyState = 4;
  seeking = false;
  time = 3;
  writes = 0;
  get currentTime() { return this.time; }
  set currentTime(value) { this.writes += 1; this.time = value; this.seeking = true; }
  emit(type) { this.dispatchEvent(new Event(type)); }
}

test("opening stays muted until asynchronous rewind AND buffering settle", () => {
  const audio = new AudioFixture();
  let reveals = 0;
  prepareOpeningAudio(audio, () => reveals++, () => assert.fail("unexpected error"));
  assert.equal(audio.writes, 1);
  assert.equal(reveals, 0);
  audio.emit("playing");
  audio.emit("canplay");
  assert.equal(reveals, 0, "old playable state must not release pre-roll");
  audio.readyState = 2;
  audio.seeking = false;
  audio.emit("seeked");
  assert.equal(reveals, 0, "seek completion alone does not prove playable data");
  audio.readyState = 3;
  audio.emit("canplay");
  assert.equal(reveals, 1);
  audio.emit("playing"); audio.emit("seeked"); audio.emit("canplay");
  assert.equal(reveals, 1, "repeated media events must not reveal or rewind again");
});

test("zero-position delayed media starts without a needless rewind", () => {
  const audio = new AudioFixture(); audio.time = 0; audio.readyState = 0;
  let reveals = 0;
  prepareOpeningAudio(audio, () => reveals++, () => assert.fail("unexpected error"));
  assert.equal(audio.writes, 0);
  assert.equal(reveals, 0);
  audio.readyState = 4; audio.emit("playing");
  assert.equal(reveals, 1);
});

test("cancel/unmount cannot reveal after late seek or readiness events", () => {
  const audio = new AudioFixture(); let reveals = 0;
  const cancel = prepareOpeningAudio(audio, () => reveals++, () => assert.fail("unexpected error"));
  cancel(); cancel(); audio.seeking = false; audio.emit("seeked"); audio.emit("canplay");
  assert.equal(reveals, 0);
});

test("media failure is reported once without releasing pre-roll", () => {
  const audio = new AudioFixture(); let reveals = 0; let failures = 0;
  prepareOpeningAudio(audio, () => reveals++, () => failures++);
  audio.emit("error"); audio.emit("error"); audio.seeking = false; audio.emit("seeked");
  assert.equal(failures, 1); assert.equal(reveals, 0);
});

test("seek failure keeps the audio muted and permits recovery", () => {
  const audio = new AudioFixture(); let failures = 0;
  Object.defineProperty(audio, "currentTime", { get: () => 3, set() { throw new Error("seek failed"); } });
  prepareOpeningAudio(audio, () => assert.fail("must remain muted"), () => failures++);
  assert.equal(failures, 1);
});
