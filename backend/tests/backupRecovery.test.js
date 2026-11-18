/**
 * StockSense AI — Milestone 6A.2: Automated Database Backup and Recovery Tests
 * Tests backup generation, SHA-256 checksums, archive integrity, retention enforcement,
 * and production restore protection safeguards.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const scriptsDir = path.resolve(rootDir, 'scripts');

describe('Milestone 6A.2: Automated Database Backup & Recovery Tests', () => {
  const testBackupDir = path.resolve(rootDir, 'backups/test_postgres_automation');

  test('1. backup_postgres.sh creates a valid compressed backup and SHA-256 checksum', () => {
    // Ensure clean test backup directory
    fs.mkdirSync(testBackupDir, { recursive: true });

    const env = {
      ...process.env,
      BACKUP_DIR: testBackupDir,
      RETENTION_DAYS: '7',
    };

    const output = execFileSync(path.join(scriptsDir, 'backup_postgres.sh'), {
      env,
      encoding: 'utf8',
    });

    assert.ok(output.includes('[Backup SUCCESS]'), 'Expected backup success message');
    assert.ok(output.includes('[Retention]'), 'Expected retention check message');

    const files = fs.readdirSync(testBackupDir);
    const sqlGzFiles = files.filter((f) => f.endsWith('.sql.gz'));
    const shaFiles = files.filter((f) => f.endsWith('.sha256'));

    assert.ok(sqlGzFiles.length >= 1, 'Expected at least one .sql.gz backup file');
    assert.ok(shaFiles.length >= 1, 'Expected at least one .sha256 checksum file');

    const backupFile = path.join(testBackupDir, sqlGzFiles[0]);
    assert.ok(fs.statSync(backupFile).size > 1000, 'Backup file should have non-trivial size');
  });

  test('2. verify_backup.sh successfully validates checksum and gzip integrity of valid backup', () => {
    const files = fs.readdirSync(testBackupDir);
    const sqlGzFile = files.find((f) => f.endsWith('.sql.gz'));
    assert.ok(sqlGzFile, 'Backup file must exist for verification test');

    const backupPath = path.join(testBackupDir, sqlGzFile);
    const output = execFileSync(path.join(scriptsDir, 'verify_backup.sh'), [backupPath], {
      encoding: 'utf8',
    });

    assert.ok(output.includes('SHA-256 checksum verified successfully'));
    assert.ok(output.includes('Gzip compression integrity confirmed'));
    assert.ok(output.includes('[Verify SUCCESS] Valid PostgreSQL dump signature verified'));
  });

  test('3. verify_backup.sh fails safely if archive checksum is tampered with', () => {
    const files = fs.readdirSync(testBackupDir);
    const sqlGzFile = files.find((f) => f.endsWith('.sql.gz'));
    assert.ok(sqlGzFile);

    const backupPath = path.join(testBackupDir, sqlGzFile);
    const checksumPath = `${backupPath}.sha256`;

    // Write a corrupted checksum file
    const corruptedChecksum = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  tampered.sql.gz\n';
    const tempChecksumPath = path.join(testBackupDir, 'tampered.sha256');
    fs.writeFileSync(tempChecksumPath, corruptedChecksum, 'utf8');

    assert.throws(
      () => {
        execFileSync(path.join(scriptsDir, 'verify_backup.sh'), [backupPath, tempChecksumPath], {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      },
      /Command failed/,
      'Verification must fail when checksum does not match'
    );

    // Clean up temporary checksum
    fs.unlinkSync(tempChecksumPath);
  });

  test('4. restore_postgres_validation.sh strictly rejects restoration targeting production database', () => {
    const files = fs.readdirSync(testBackupDir);
    const sqlGzFile = files.find((f) => f.endsWith('.sql.gz'));
    assert.ok(sqlGzFile);

    const backupPath = path.join(testBackupDir, sqlGzFile);

    // Test rejection with production database name
    assert.throws(
      () => {
        execFileSync(
          path.join(scriptsDir, 'restore_postgres_validation.sh'),
          [backupPath, 'stocksense_db'],
          {
            encoding: 'utf8',
            stdio: 'pipe',
          }
        );
      },
      (err) => {
        const stderr = err.stderr ? err.stderr.toString() : '';
        return stderr.includes('CRITICAL ERROR') && stderr.includes('strictly prohibited');
      },
      'Expected restore script to abort when target is production database'
    );
  });

  test('5. Safe retention safeguard never deletes the last remaining valid backup', () => {
    // When only 1 backup exists, even with RETENTION_DAYS=0, the backup MUST NOT be pruned
    const env = {
      ...process.env,
      BACKUP_DIR: testBackupDir,
      RETENTION_DAYS: '0',
    };

    const output = execFileSync(path.join(scriptsDir, 'backup_postgres.sh'), {
      env,
      encoding: 'utf8',
    });

    const files = fs.readdirSync(testBackupDir);
    const remainingBackups = files.filter((f) => f.endsWith('.sql.gz'));
    assert.ok(remainingBackups.length >= 1, 'Safe retention must retain at least one valid backup');

    // Clean up test directory
    fs.rmSync(testBackupDir, { recursive: true, force: true });
  });
});
