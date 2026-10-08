# Site Actions Capture (Android)

Take site photos, write the action to be done, and send a ZIP to Site Register.
Works fully offline. No login, no server, no analytics.

## What you need to know first
- The app saves everything on the phone. Nothing is sent anywhere until you tap Export and choose where to share the ZIP (WhatsApp, email, Drive, Bluetooth, USB copy).
- Project and people names are typed once in Settings. Use EXACTLY the same names as in Site Register so the desktop import matches them.
- Entries stay "Pending" until you confirm "Did the export go through? Yes".

## Get the APK - choose ONE way

### Way A: Android Studio (on your PC)
1. Install Node.js (LTS, version 22 or newer): https://nodejs.org
2. Install Android Studio: https://developer.android.com/studio . Open it once and let it download the Android SDK.
3. Unzip this project. Open a Command Prompt inside the folder and run:
       npm install
       npx cap sync android
       npx cap open android
4. Android Studio opens. Wait for "Gradle sync" to finish (the first time can take 5-15 minutes and needs internet).
5. Menu: Build > Build Bundle(s) / APK(s) > Build APK(s). When it finishes click "locate".
   The file is android/app/build/outputs/apk/debug/app-debug.apk

### Way B: GitHub (no Android Studio)
1. Create a free GitHub account and a new PRIVATE repository.
2. Upload every file and folder of this project (keep the hidden .github folder). Or with git: git init, git add ., git commit, push to branch "main".
3. Open the repository > Actions tab > "Build APK" > Run workflow.
4. After about 5-10 minutes open the finished run and download "SiteActions-APK". Unzip it to get app-debug.apk.

## Install on a phone
1. Send app-debug.apk to the phone (WhatsApp as Document, email, USB or Drive).
2. Tap the file. If asked, allow "Install unknown apps" for that app (once).
3. Open "Site Actions". Go to Settings, add the device name, projects and people.

## Test checklist (do this on a real phone before rolling out)
- [ ] Settings: add 2 projects, 2 people, a device name. Import a .txt list (one name per line).
- [ ] New action: take 2 photos, add a caption, High priority, due date, Save.
- [ ] Re-open the action, remove one photo, Save. Photo count updates.
- [ ] Save an action with no photo: it shows "Incomplete" and Export blocks it with the reason.
- [ ] Turn on airplane mode: everything above still works.
- [ ] Force-close the app, reopen: all actions still there. Restart the phone: still there.
- [ ] Export: share sheet opens; send the ZIP to your PC (WhatsApp Web, email or USB).
- [ ] Choose "No, keep as pending": actions stay Pending. Export again, choose Yes: they show Exported.
- [ ] Unzip on PC: manifest.json plus a photos folder. Photo file names match manifest.json.
- [ ] Photo properties on PC show no GPS location.
- [ ] Import the ZIP into Site Register (Part B). Import it twice: no duplicates.

## Notes
- The extra copy of each export in Documents/SiteActions works on most phones but Android sometimes blocks it. The app tells you if it could not save it; the shared file is still created.
- Exported actions stay on the phone until you tap Settings > Delete exported actions.
- Debug APK: fine for company use by sideloading. It is not for the Play Store.
- Optional: replace the default app icon in android/app/src/main/res/mipmap-* (Android Studio: right-click res > New > Image Asset).

## For developers
- ZIP format (fixed contract): see buildManifest() in www/js/core.js. Do not change field names.
- Tests: `npm run test` (format contract). UI flow test: `JSDOM_PATH=<path to jsdom> node test/app.flow.test.js` (needs jsdom installed separately).
- Stack: plain HTML/JS in www/, Capacitor 8 (Camera, Filesystem, Share, Preferences, App), JSZip bundled locally.
