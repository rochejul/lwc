/*
 * Copyright (c) 2024, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */
import { runJsFrameworkBenchmark, WARMUP_COUNT } from '../../../utils/runJsFrameworkBenchmark.js';

// Based on https://github.com/krausest/js-framework-benchmark/blob/6c9f43f/webdriver-ts/src/benchmarksPuppeteer.ts
// See `benchUpdate()`
runJsFrameworkBenchmark(
    `dom/js-framework-benchmark/partial-update/1k`,
    { benchmark, before, run, after },
    {
        async warmup({ run, update }) {
            await run();
            for (let i = 0; i < WARMUP_COUNT; i++) {
                await update();
            }
        },
        async execute({ update }) {
            await update();
        },
    }
);
