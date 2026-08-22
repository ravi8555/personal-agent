import { BackgroundScheduler } from "../app/backgroundScheduler.js";

let processCount = 0;

const processor =  {
    async process() {
        processCount++;
        console.log(
            `PROCESS RUN #${processCount}`,
        );
    },
};

const scheduler = new BackgroundScheduler({
    processor,
    intervalMs: 50,
    runImmediately: true,
});

console.log("\n===== INITIAL STATE =====");
console.log("isRunning:", scheduler.isRunning);
console.log("processCount:", processCount);

console.log("\n===== START =====");

scheduler.start();

console.log("isRunning:", scheduler.isRunning);

// Calling start() again must NOT create another interval.
scheduler.start();

console.log("Called start() twice.");

await new Promise(resolve => setTimeout(resolve, 180));

console.log("\n===== AFTER 180ms =====");
console.log("processCount:", processCount);

console.log("\n===== STOP =====");

scheduler.stop();

console.log("isRunning:", scheduler.isRunning);

const countAfterStop = processCount;

await new Promise(resolve => setTimeout(resolve, 150));

console.log("\n===== AFTER STOP =====");
console.log("processCount:", processCount);
console.log(
    "New executions after stop:",
    processCount - countAfterStop,
);

console.log("\n===== TEST COMPLETE =====");
// npm exec tsx src/tests/background-scheduler-test.ts