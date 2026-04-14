import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const SCREENSHOT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const SCREENSHOT_NAME_HINTS = ['screenshot', 'screen-shot', 'screen_shot', 'snapshot'];
const DEBUG_LOG_PATH = '/tmp/imgur-screenshot-uploader.log';
const CANDIDATE_DELAY_MS = 200;

const NotificationPolicy = GObject.registerClass(
class NotificationPolicy extends MessageTray.NotificationPolicy {
    get enable() {
        return true;
    }

    get enableSound() {
        return false;
    }

    get showBanners() {
        return true;
    }

    get forceExpanded() {
        return false;
    }

    get showInLockScreen() {
        return false;
    }

    get detailsInLockScreen() {
        return false;
    }

    store() {
    }
});

export default class ImgurScreenshotUploaderExtension extends Extension {
    enable() {
        this._debug('enable()');
        this._settings = this.getSettings();
        this._clipboard = St.Clipboard.get_default();
        this._fileMonitors = [];
        this._pendingCandidates = new Map();
        this._seenPaths = new Map();
        this._source = null;
        this._latestScreenshotPath = null;

        this._origAddNotification = MessageTray.Source.prototype.addNotification;
        const extension = this;
        MessageTray.Source.prototype.addNotification = function (notification) {
            extension._maybeAttachUploadAction(notification, this);
            return extension._origAddNotification.call(this, notification);
        };

        this._startMonitoringScreenshotLocations();
    }

    disable() {
        this._debug('disable()');

        for (const monitor of this._fileMonitors)
            monitor.cancel();

        this._fileMonitors = [];

        for (const sourceId of this._pendingCandidates.values())
            GLib.Source.remove(sourceId);

        this._pendingCandidates.clear();
        this._seenPaths.clear();
        if (this._source) {
            this._source.destroy();
            this._source = null;
        }
        if (this._origAddNotification) {
            MessageTray.Source.prototype.addNotification = this._origAddNotification;
            this._origAddNotification = null;
        }
        this._latestScreenshotPath = null;
        this._clipboard = null;
        this._settings = null;
    }

    _startMonitoringScreenshotLocations() {
        const picturesDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
        const paths = new Set();
        this._debug(`picturesDir=${picturesDir ?? 'null'}`);

        if (picturesDir) {
            paths.add(picturesDir);
            paths.add(GLib.build_filenamev([picturesDir, 'Screenshots']));
        }

        for (const path of paths)
            this._monitorDirectory(path);
    }

    _monitorDirectory(path) {
        const file = Gio.File.new_for_path(path);

        try {
            if (!file.query_exists(null)) {
                this._debug(`monitor skip missing path=${path}`);
                return;
            }

            const monitor = file.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            monitor.connect('changed', (_monitor, changedFile, otherFile, eventType) => {
                this._onDirectoryChanged(changedFile, otherFile, eventType);
            });
            this._fileMonitors.push(monitor);
            this._debug(`monitoring path=${path}`);
        } catch (error) {
            this._debug(`monitor error path=${path} error=${error.message}`);
            console.error(`${this.metadata.uuid}: failed to monitor ${path}: ${error.message}`);
        }
    }

    _onDirectoryChanged(file, otherFile, eventType) {
        switch (eventType) {
        case Gio.FileMonitorEvent.CREATED:
        case Gio.FileMonitorEvent.MOVED_IN:
            this._queueCandidate(file);
            break;
        case Gio.FileMonitorEvent.RENAMED:
            this._queueCandidate(otherFile ?? file);
            break;
        default:
            break;
        }
    }

    _queueCandidate(file) {
        if (!file)
            return;

        const path = file.get_path();
        if (!path) {
            this._debug('queueCandidate without path');
            return;
        }

        if (!this._looksLikeScreenshotPath(path)) {
            this._debug(`ignore non-screenshot path=${path}`);
            return;
        }

        this._debug(`queueCandidate path=${path}`);

        if (this._pendingCandidates.has(path))
            GLib.Source.remove(this._pendingCandidates.get(path));

        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CANDIDATE_DELAY_MS, () => {
            this._pendingCandidates.delete(path);
            this._maybeOfferUpload(path);
            return GLib.SOURCE_REMOVE;
        });

        this._pendingCandidates.set(path, sourceId);
    }

    _looksLikeScreenshotPath(path) {
        const lowerPath = path.toLowerCase();
        if (!SCREENSHOT_EXTENSIONS.some(ext => lowerPath.endsWith(ext)))
            return false;

        const basename = GLib.path_get_basename(lowerPath);
        if (SCREENSHOT_NAME_HINTS.some(hint => basename.includes(hint)))
            return true;

        return lowerPath.includes('/screenshots/');
    }

    _maybeOfferUpload(path) {
        const file = Gio.File.new_for_path(path);

        try {
            const info = file.query_info(
                'standard::type,time::modified,standard::size',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            if (info.get_file_type() !== Gio.FileType.REGULAR)
                return;

            const modifiedSecs = info.get_attribute_uint64('time::modified');
            const ageSecs = Math.floor(GLib.get_real_time() / 1000000) - modifiedSecs;
            this._debug(`inspect path=${path} ageSecs=${ageSecs} size=${info.get_size()}`);

            if (ageSecs > 15)
                return;

            const size = info.get_size();
            const seenEntry = this._seenPaths.get(path);
            if (seenEntry && seenEntry.size === size && seenEntry.modifiedSecs === modifiedSecs)
                return;

            this._seenPaths.set(path, {size, modifiedSecs});
            this._latestScreenshotPath = path;
            this._debug(`latestScreenshotPath path=${path}`);
        } catch (error) {
            this._debug(`inspect error path=${path} error=${error.message}`);
            console.error(`${this.metadata.uuid}: failed to inspect ${path}: ${error.message}`);
        }
    }

    async _uploadScreenshot(path) {
        this._debug(`upload requested path=${path}`);
        const clientId = this._settings.get_string('imgur-client-id').trim();
        if (!clientId) {
            this._showNotification(this._createNotification(
                'Imgur Client ID missing',
                'Open extension preferences and set your Imgur Client ID first.'
            ));
            return;
        }

        try {
            const link = await this._runImgurUpload(path, clientId);
            this._debug(`upload success path=${path} link=${link}`);
            const notification = this._createNotification(
                'Imgur upload complete',
                link
            );
            notification.addAction('Copy Link', () => {
                this._copyLink(link);
            });
            this._showNotification(notification);
        } catch (error) {
            this._debug(`upload failed path=${path} error=${error.message}`);
            this._showNotification(this._createNotification(
                'Imgur upload failed',
                error.message
            ));
        }
    }

    _runImgurUpload(path, clientId) {
        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = Gio.Subprocess.new(
                    [
                        'curl',
                        '--silent',
                        '--show-error',
                        '--fail-with-body',
                        'https://api.imgur.com/3/image',
                        '-H',
                        `Authorization: Client-ID ${clientId}`,
                        '-F',
                        `image=@${path}`,
                    ],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
            } catch (error) {
                reject(error);
                return;
            }

            proc.communicate_utf8_async(null, null, (subprocess, result) => {
                try {
                    const [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
                    if (!subprocess.get_successful())
                        throw new Error(stderr.trim() || stdout.trim() || 'curl exited with a failure status');

                    const payload = JSON.parse(stdout);
                    if (!payload?.success || !payload?.data?.link)
                        throw new Error(payload?.data?.error || 'Imgur response did not contain a link');

                    resolve(payload.data.link);
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    _copyLink(link) {
        this._debug(`copyLink link=${link}`);
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, link);
        this._clipboard.set_text(St.ClipboardType.PRIMARY, link);
    }

    _maybeAttachUploadAction(notification, source) {
        try {
            const title = `${notification.title ?? ''}`;
            const lowerTitle = title.toLowerCase();
            const sourceTitle = `${source?.title ?? ''}`.toLowerCase();

            const looksLikeScreenshotNotification =
                lowerTitle.includes('screenshot captured') ||
                (lowerTitle.includes('screenshot') && sourceTitle.includes('screenshot'));

            if (!looksLikeScreenshotNotification)
                return;

            const path = this._latestScreenshotPath;
            if (!path)
                return;

            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null))
                return;

            this._debug(`attach upload action title=${title} path=${path}`);
            notification.addAction('Upload to Imgur', () => {
                this._uploadScreenshot(path);
            });
        } catch (error) {
            this._debug(`attach action error=${error.message}`);
        }
    }

    _getSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({
                title: 'Imgur Screenshot Uploader',
                iconName: 'image-x-generic-symbolic',
                policy: new NotificationPolicy(),
            });
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }

        return this._source;
    }

    _createNotification(title, body) {
        return new MessageTray.Notification({
            source: this._getSource(),
            title,
            body,
            iconName: 'image-x-generic-symbolic',
            urgency: MessageTray.Urgency.HIGH,
        });
    }

    _showNotification(notification) {
        this._debug(`show notification title=${notification.title}`);
        this._getSource().addNotification(notification);
    }

    _debug(message) {
        try {
            const now = GLib.DateTime.new_now_local().format('%F %T');
            const line = `[${now}] ${message}\n`;
            let current = '';
            try {
                current = GLib.file_get_contents(DEBUG_LOG_PATH)[1];
            } catch (_error) {
            }

            GLib.file_set_contents(DEBUG_LOG_PATH, `${current}${line}`);
        } catch (_error) {
        }
    }
}
