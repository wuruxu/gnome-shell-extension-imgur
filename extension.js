import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const SCREENSHOT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const SCREENSHOT_NAME_HINTS = ['screenshot', 'screen-shot', 'screen_shot', 'snapshot'];
const CANDIDATE_DELAY_MS = 200;
let soupSession = null;

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
        this._settings = this.getSettings();
        this._clipboard = St.Clipboard.get_default();
        this._fileMonitors = [];
        this._pendingCandidates = new Map();
        this._pendingNotificationRetries = new Map();
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
        for (const monitor of this._fileMonitors)
            monitor.cancel();

        this._fileMonitors = [];

        for (const sourceId of this._pendingCandidates.values())
            GLib.Source.remove(sourceId);

        this._pendingCandidates.clear();
        for (const sourceId of this._pendingNotificationRetries.values())
            GLib.Source.remove(sourceId);
        this._pendingNotificationRetries.clear();
        this._seenPaths.clear();
        if (this._source) {
            this._source.destroy();
            this._source = null;
        }
        if (this._origAddNotification) {
            MessageTray.Source.prototype.addNotification = this._origAddNotification;
            this._origAddNotification = null;
        }
        if (soupSession) {
            soupSession.abort();
            soupSession = null;
        }
        this._latestScreenshotPath = null;
        this._clipboard = null;
        this._settings = null;
    }

    _startMonitoringScreenshotLocations() {
        const picturesDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
        const paths = new Set();

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
                return;
            }

            const monitor = file.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            monitor.connect('changed', (_monitor, changedFile, otherFile, eventType) => {
                this._onDirectoryChanged(changedFile, otherFile, eventType);
            });
            this._fileMonitors.push(monitor);
        } catch (error) {
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
            return;
        }

        if (!this._looksLikeScreenshotPath(path)) {
            return;
        }


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

            if (ageSecs > 15)
                return;

            const size = info.get_size();
            const seenEntry = this._seenPaths.get(path);
            if (seenEntry && seenEntry.size === size && seenEntry.modifiedSecs === modifiedSecs)
                return;

            this._seenPaths.set(path, {size, modifiedSecs});
            this._latestScreenshotPath = path;
        } catch (error) {
            console.error(`${this.metadata.uuid}: failed to inspect ${path}: ${error.message}`);
        }
    }

    async _uploadScreenshot(path) {
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
            const notification = this._createNotification(
                'Imgur upload complete',
                link
            );
            notification.addAction('Copy Link', () => {
                this._copyLink(link);
            });
            this._showNotification(notification);
        } catch (error) {
            this._showNotification(this._createNotification(
                'Imgur upload failed',
                error.message
            ));
        }
    }

    _runImgurUpload(path, clientId) {
        return new Promise((resolve, reject) => {
            try {
                if (!soupSession) {
                    soupSession = new Soup.Session({
                        user_agent: 'gnome-shell-extension-imgur/1.0',
                    });
                }

                const file = Gio.File.new_for_path(path);
                const [bytes] = file.load_bytes(null);
                const basename = GLib.path_get_basename(path);
                const multipart = new Soup.Multipart('multipart/form-data');
                multipart.append_form_file(
                    'image',
                    basename,
                    this._guessContentType(path),
                    bytes
                );

                const message = Soup.Message.new_from_multipart(
                    'https://api.imgur.com/3/image',
                    multipart
                );

                if (!message)
                    throw new Error('Failed to create Imgur upload request');

                message.request_headers.append(
                    'Authorization',
                    `Client-ID ${clientId}`
                );

                soupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                    try {
                        const responseBytes = session.send_and_read_finish(result);
                        const responseText = new TextDecoder().decode(responseBytes.get_data());
                        const status = message.get_status();

                        if (status < 200 || status >= 300) {
                            let detail = message.get_reason_phrase() || `HTTP ${status}`;
                            try {
                                const errorPayload = JSON.parse(responseText);
                                detail = errorPayload?.data?.error || errorPayload?.error || detail;
                            } catch (_error) {
                            }
                            throw new Error(detail);
                        }

                        const payload = JSON.parse(responseText);
                        if (!payload?.success || !payload?.data?.link)
                            throw new Error(payload?.data?.error || 'Imgur response did not contain a link');

                        resolve(payload.data.link);
                    } catch (error) {
                        reject(error);
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    _guessContentType(path) {
        const lowerPath = path.toLowerCase();

        if (lowerPath.endsWith('.png'))
            return 'image/png';
        if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg'))
            return 'image/jpeg';
        if (lowerPath.endsWith('.webp'))
            return 'image/webp';

        return 'application/octet-stream';
    }

    _copyLink(link) {
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, link);
        this._clipboard.set_text(St.ClipboardType.PRIMARY, link);
    }

    _maybeAttachUploadAction(notification, source) {
        try {
            if (notification._imgurUploadActionAttached)
                return;

            const title = `${notification.title ?? ''}`;
            const lowerTitle = title.toLowerCase();
            const sourceTitle = `${source?.title ?? ''}`.toLowerCase();

            const looksLikeScreenshotNotification =
                lowerTitle.includes('screenshot captured') ||
                (lowerTitle.includes('screenshot') && sourceTitle.includes('screenshot'));

            if (!looksLikeScreenshotNotification)
                return;

            const path = this._latestScreenshotPath;
            if (!path) {
                this._scheduleAttachRetry(notification);
                return;
            }

            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null)) {
                this._scheduleAttachRetry(notification);
                return;
            }

            notification._imgurUploadActionAttached = true;
            notification.addAction('Upload To Imgur', () => {
                this._uploadScreenshot(path);
            });
            this._cancelAttachRetry(notification);
        } catch (error) {
        }
    }

    _scheduleAttachRetry(notification) {
        if (notification._imgurUploadActionAttached || this._pendingNotificationRetries.has(notification))
            return;

        notification._imgurUploadActionRetryCount = 0;

        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (notification._imgurUploadActionAttached) {
                this._pendingNotificationRetries.delete(notification);
                return GLib.SOURCE_REMOVE;
            }

            notification._imgurUploadActionRetryCount += 1;
            this._maybeAttachUploadAction(notification, notification.source);

            if (notification._imgurUploadActionAttached ||
                notification._imgurUploadActionRetryCount >= 10) {
                this._pendingNotificationRetries.delete(notification);
                return GLib.SOURCE_REMOVE;
            }

            return GLib.SOURCE_CONTINUE;
        });

        this._pendingNotificationRetries.set(notification, sourceId);
    }

    _cancelAttachRetry(notification) {
        const sourceId = this._pendingNotificationRetries.get(notification);
        if (!sourceId)
            return;

        GLib.Source.remove(sourceId);
        this._pendingNotificationRetries.delete(notification);
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
        this._getSource().addNotification(notification);
    }
}
