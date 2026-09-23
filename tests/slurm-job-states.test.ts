import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// sacct --parsable2 reports a user cancellation as "CANCELLED by <uid>", not "CANCELLED". The scanner must still
// count those jobs as failed instead of scoring them as tracked compute.

const root = join(import.meta.dirname, '..');
const scanner = join(root, 'static/scan.sh');
const fixtureDirs: string[] = [];

const sacctStub = `#!/usr/bin/env bash
printf '%s' "$FAKE_SACCT"
`;

function findExecutable(name: string): string {
	for (const directory of process.env.PATH?.split(delimiter) ?? []) {
		const executable = join(directory, name);
		try {
			accessSync(executable, constants.X_OK);
			return executable;
		} catch {
			// Keep looking in the remaining PATH entries.
		}
	}
	throw new Error(`Required command not found: ${name}`);
}

function scanReport(sacct: string): Record<string, unknown> {
	const fixtureDir = mkdtempSync(join(tmpdir(), 'wastage-slurm-'));
	fixtureDirs.push(fixtureDir);

	const requiredCommands = ['awk', 'bash', 'cat', 'date', 'grep', 'head', 'mktemp', 'rm', 'sed', 'sleep', 'tr', 'wc'];
	for (const command of requiredCommands) {
		symlinkSync(findExecutable(command), join(fixtureDir, command));
	}

	const sacctPath = join(fixtureDir, 'sacct');
	writeFileSync(sacctPath, sacctStub);
	chmodSync(sacctPath, 0o755);

	const output = execFileSync(join(fixtureDir, 'bash'), [scanner, '--local', '--json'], {
		cwd: fixtureDir,
		encoding: 'utf8',
		input: '\n',
		timeout: 15_000,
		env: { ...process.env, PATH: fixtureDir, FAKE_SACCT: sacct }
	});

	const reportStart = output.indexOf('{\n  "scheduler_type"');
	expect(reportStart, 'scanner JSON report').toBeGreaterThanOrEqual(0);
	return JSON.parse(output.slice(reportStart)) as Record<string, unknown>;
}

// JobID|AllocCPUS|Elapsed|TotalCPU|ReqMem|MaxRSS|AllocTRES|State, as sacct --parsable2 prints them.
function job(id: number, totalCpu: string, state: string): string {
	return `${id}|8|01:00:00|${totalCpu}|16G|0|billing=8,cpu=8,mem=16G,node=1|${state}\n`;
}

describe('SLURM job states', () => {
	afterEach(() => {
		for (const fixtureDir of fixtureDirs.splice(0)) rmSync(fixtureDir, { recursive: true, force: true });
	});

	it('counts a job cancelled by a user as failed', () => {
		const report = scanReport(
			job(101, '07:30:00', 'COMPLETED') + job(102, '00:30:00', 'CANCELLED by 1001') + job(103, '00:30:00', 'FAILED')
		);

		expect(report).toMatchObject({
			job_count: 3,
			failed_jobs: 2,
			avg_cpu_waste_pct: 6.25,
			wasted_core_hours: 0.5
		});
	});

	it('counts a job that hit its deadline as failed', () => {
		const report = scanReport(job(101, '07:30:00', 'COMPLETED') + job(102, '00:30:00', 'DEADLINE'));

		expect(report).toMatchObject({ job_count: 2, failed_jobs: 1, avg_cpu_waste_pct: 6.25 });
	});
});
