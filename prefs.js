import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ImgurScreenshotUploaderPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'image-x-generic-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Imgur',
            description: 'Set the Client ID for anonymous uploads.',
        });

        const row = new Adw.EntryRow({
            title: 'Client ID',
            text: settings.get_string('imgur-client-id'),
        });
        row.connect('notify::text', entry => {
            settings.set_string('imgur-client-id', entry.get_text().trim());
        });

        const helpRow = new Adw.ActionRow({
            title: 'Behavior',
            subtitle: 'The extension watches your Pictures folder for new screenshot files and offers an Imgur upload action.',
        });
        helpRow.add_suffix(new Gtk.Image({
            icon_name: 'dialog-information-symbolic',
        }));

        group.add(row);
        group.add(helpRow);
        page.add(group);
        window.add(page);
    }
}
