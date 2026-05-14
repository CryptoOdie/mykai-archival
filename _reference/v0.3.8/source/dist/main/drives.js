"use strict";
/**
 * Drive enumeration + classification for the data-directory picker.
 *
 * For non-tech users: show a list of drives with their free space and
 * whether they're suitable for Kaspa data. We mark:
 *  - Internal SSD / HDD        → OK
 *  - External USB 3.0+ SSD     → OK
 *  - USB stick / thumb drive   → BLOCKED (will physically wear out)
 *  - USB 2.0 drive             → BLOCKED (too slow, sync will stall)
 *  - CD / DVD / network share  → BLOCKED (wrong type)
 *  - Drive with < ~40 GB free  → BLOCKED (not enough headroom)
 *
 * Implementation: PowerShell `Get-Volume` + `Get-PhysicalDisk` on Windows.
 * No PowerShell on mac/linux yet — that's a 0.2.28+ port.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.enumerateDrives = enumerateDrives;
exports.getDriveForPath = getDriveForPath;
const child_process_1 = require("child_process");
/** List all drives visible to Windows, classified for the picker. */
async function enumerateDrives() {
    if (process.platform !== 'win32')
        return [];
    try {
        const json = await runPowerShell(ENUMERATE_SCRIPT, 10_000);
        const raw = JSON.parse(json || '[]');
        const arr = Array.isArray(raw) ? raw : [raw];
        return arr.map(classify).filter(Boolean);
    }
    catch {
        return [];
    }
}
/**
 * Given a drive letter (or full path), return its DriveInfo.
 * Used for validating that a user-entered path points at a suitable drive.
 */
async function getDriveForPath(path) {
    const letter = (path.match(/^([A-Za-z]):/) || [])[1];
    if (!letter)
        return null;
    const all = await enumerateDrives();
    return all.find(d => d.letter.toUpperCase() === (letter.toUpperCase() + ':')) || null;
}
// ─── Internal helpers ──────────────────────────────────────────────────
/** PowerShell script that returns one object per mounted drive letter. */
const ENUMERATE_SCRIPT = `
$drives = Get-Volume | Where-Object { $_.DriveLetter -and $_.FileSystem -ne $null }
$out = @()
foreach ($v in $drives) {
  $letter = "$($v.DriveLetter):"
  $label = $v.FileSystemLabel
  $free = $v.SizeRemaining
  $total = $v.Size
  # Find the physical disk backing this volume
  try {
    $partition = Get-Partition -DriveLetter $v.DriveLetter -ErrorAction SilentlyContinue | Select-Object -First 1
    $disk = if ($partition) { Get-Disk -Number $partition.DiskNumber -ErrorAction SilentlyContinue } else { $null }
    $pd = if ($disk) { Get-PhysicalDisk | Where-Object { $_.DeviceId -eq $disk.Number -or $_.FriendlyName -eq $disk.FriendlyName } | Select-Object -First 1 } else { $null }
    $bus = if ($pd) { $pd.BusType } else { 'Unknown' }
    $media = if ($pd) { $pd.MediaType } else { 'Unspecified' }
    $removable = $false
    if ($disk -and $null -ne $disk.IsBoot -eq $false -and $disk.BusType -eq 'USB') { $removable = $true }
  } catch {
    $bus = 'Unknown'; $media = 'Unspecified'; $removable = $false
  }
  $out += [ordered]@{
    Letter = $letter
    Label = $label
    Free = [int64]$free
    Total = [int64]$total
    Bus = "$bus"
    Media = "$media"
    Removable = $removable
    DriveType = ($v.DriveType)
  }
}
ConvertTo-Json -InputObject $out -Compress
`;
function classify(raw) {
    if (!raw?.Letter)
        return null;
    const bus = String(raw.Bus || 'Unknown');
    const media = String(raw.Media || 'Unspecified');
    const driveType = String(raw.DriveType || 'Unknown');
    const free = Number(raw.Free || 0);
    const total = Number(raw.Total || 0);
    const busLower = bus.toLowerCase();
    const mediaLower = media.toLowerCase();
    const driveTypeLower = driveType.toLowerCase();
    let kind = 'unknown';
    let suitable = true;
    let reason;
    // Network / optical drives — always blocked
    if (driveTypeLower.includes('network')) {
        kind = 'network';
        suitable = false;
        reason = 'Network drives aren\u2019t supported — choose a local drive.';
    }
    else if (driveTypeLower.includes('cdrom') || driveTypeLower.includes('optical')) {
        kind = 'optical';
        suitable = false;
        reason = 'Optical drives (CD/DVD) can\u2019t store Kaspa data.';
    }
    // USB bus — could be SSD, HDD, or stick
    else if (busLower.includes('usb')) {
        // USB sticks typically show MediaType as Unspecified or SCM; they're
        // also usually small (< 256 GB). Actual SSDs in enclosures report SSD.
        if (mediaLower.includes('ssd')) {
            kind = 'external-ssd';
        }
        else if (mediaLower.includes('hdd')) {
            kind = 'external-hdd';
        }
        else if (total > 0 && total < 256 * 1024 * 1024 * 1024) {
            // Small USB drive with unspecified media — likely a thumb drive
            kind = 'usb-stick';
            suitable = false;
            reason = 'USB sticks wear out quickly — use an external SSD or HDD instead.';
        }
        else {
            // Large USB drive with unspecified media — probably an external drive
            kind = 'external-hdd';
        }
        // NOTE: USB 2.0 vs 3.0 detection from PowerShell is inconsistent.
        // Accept all USB 3.0+ speeds; can't reliably block USB 2.0 without
        // querying the USB controller hub speed which isn't exposed cleanly.
        // If this becomes a real pain point, we can iterate.
    }
    // Internal SATA / NVMe / SAS — usually OK
    else if (busLower.includes('sata') || busLower.includes('nvme') || busLower.includes('sas') || busLower.includes('raid')) {
        if (mediaLower.includes('ssd'))
            kind = 'internal-ssd';
        else if (mediaLower.includes('hdd'))
            kind = 'internal-hdd';
        else
            kind = 'internal-ssd'; // modern default
    }
    else {
        kind = 'unknown';
    }
    // Free-space gate (40 GB minimum — matches pre-start threshold)
    const MIN_FREE_GATE = 40 * 1024 * 1024 * 1024;
    if (suitable && free > 0 && free < MIN_FREE_GATE) {
        suitable = false;
        reason = `Only ${(free / 1_073_741_824).toFixed(1)} GB free. Need 40+ GB.`;
    }
    return {
        letter: String(raw.Letter),
        label: String(raw.Label || ''),
        kind,
        bus,
        freeBytes: free,
        totalBytes: total,
        suitable,
        reason,
    };
}
function runPowerShell(script, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
        let out = '';
        const timer = setTimeout(() => {
            try {
                child.kill();
            }
            catch { /* ignore */ }
            reject(new Error('Timeout'));
        }, timeoutMs);
        child.stdout?.on('data', (d) => { out += d.toString(); });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('exit', () => { clearTimeout(timer); resolve(out.trim()); });
    });
}
//# sourceMappingURL=drives.js.map