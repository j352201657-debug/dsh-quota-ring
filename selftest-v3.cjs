'use strict';

/** 运行离线回归测试，保留测试运行器的退出状态。 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, ['--test', path.join(__dirname, 'tests', 'regression.test.cjs')], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status === null ? 1 : result.status;
