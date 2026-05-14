"use strict";
/**
 * Cloud Node Manager
 *
 * Generates customized mykai-monitor.sh scripts for FluxCloud (or any cloud) kaspad nodes.
 * The script reports telemetry to MyKAI Insights + KasMap independently.
 * Same script works for all cloud nodes — each generates its own Node ID on first run.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CloudNodeManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
class CloudNodeManager {
    config;
    constructor(config) {
        this.config = config;
    }
    /**
     * Generate a cloud monitor script with the user's keys baked in.
     * Returns the file path where the script was saved.
     */
    generateAndSave() {
        const accountKey = this.config.getAccountKey();
        const kasmapToken = this.config.get('kasmap')?.token || '';
        // Strict shape checks before substitution. Account keys are generated
        // locally as `acc_<32 hex chars>` and never user-edited, so a deviation
        // means the config store is corrupted — fail loud rather than emit a
        // broken or attacker-influenced script. KasMap tokens are issued by
        // mykai.dev and are also tightly shaped.
        if (!/^acc_[0-9a-f]{32}$/.test(accountKey)) {
            throw new Error('Account key has unexpected shape — refusing to generate cloud script');
        }
        if (kasmapToken && !/^[a-zA-Z0-9._-]{8,200}$/.test(kasmapToken)) {
            throw new Error('KasMap token has unexpected shape — refusing to generate cloud script');
        }
        // Read the template script
        const templatePath = this.getTemplatePath();
        // Bake in the user's config. `replaceAll` (not `replace`) so a template
        // with multiple occurrences of a placeholder substitutes them all,
        // and so the shape-checked values cannot accidentally leave a partial
        // marker behind that the next replace then walks over.
        const script = fs_1.default.readFileSync(templatePath, 'utf-8')
            .replaceAll('__ACCOUNT_KEY__', accountKey)
            .replaceAll('__KASMAP_TOKEN__', kasmapToken || '__KASMAP_TOKEN__')
            .replaceAll('__NODE_NAME__', 'Cloud Node');
        // Save to Downloads folder
        const downloadsDir = electron_1.app.getPath('downloads');
        const filePath = path_1.default.join(downloadsDir, 'mykai-monitor.sh');
        fs_1.default.writeFileSync(filePath, script, { encoding: 'utf-8', mode: 0o755 });
        return { filePath, accountKey };
    }
    /**
     * Get the path to the template shell script.
     */
    getTemplatePath() {
        if (electron_1.app.isPackaged) {
            return path_1.default.join(process.resourcesPath, 'cloud-monitor', 'mykai-monitor.sh');
        }
        return path_1.default.join(electron_1.app.getAppPath(), 'cloud-monitor', 'mykai-monitor.sh');
    }
}
exports.CloudNodeManager = CloudNodeManager;
//# sourceMappingURL=cloud-node-manager.js.map