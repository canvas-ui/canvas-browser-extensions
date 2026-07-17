<p align="center">
  <img src="https://raw.githubusercontent.com/canvas-ai/.github/main/banners/canvas-banner_1200x480.jpg" alt="Canvas" width="100%" />
</p>

# Canvas Browser Extension

A browser extension for seamlessly syncing browser tabs with Canvas server. 

The main functionality is to bind to a specific canvas-server "context"(think of it as a shareable session) and update tabs dynamically whenever the context changes.  

A more practical example: Switch your context named "work" from `universe://work/customer-a/projects/foo` to `universe://work/customer-a/devops/jira-1234`, browser automatically closes/hides existing open tabs and opens/shows tabs related to the particular context.  

Switching back-and-forth between your tasks organized in a virtual "context" tree autoloads relevant content(globaly, in all bound apps - emails, files, notes, dotfiles aaand with this extension browser tabs).

Extension allows you to (aot) work with tabs collaboratively, your significant other can bind to your context and open/close tabs in real-time, lets say to collaboratively pick an airbnb rental.

## Screenshots

### Extension Popup

![Screenshot 1](assets/screenshots/screenshot1.png)

![Screenshot 2](assets/screenshots/screenshot2.png)

![Screenshot 3](assets/screenshots/screenshot3.png)

### Extension Settings

![Screenshot 4](assets/screenshots/screenshot4.png)

![Screenshot 5](assets/screenshots/screenshot5.png)

![Screenshot 6](assets/screenshots/screenshot6.png)

## Installation

### Method 1: Browser Store Installation (Recommended)

| Browser | Store Link |
|---------|------------|
| **Chrome/Chromium** | [Chrome Web Store](https://chromewebstore.google.com/detail/nddefgjgkhcpmgpipifjacmoinoncdgl) |
| **Firefox** | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/canvas-browser-extension) |


### Method 2: Download Release Package (TBD)

Download the latest release for your browser:

| Browser | Download |
|---------|----------|
| **Chromium-based** (Chrome, Edge, Brave, Opera) | [📦 canvas-extension-chromium.zip](https://github.com/canvas-ui/canvas-browser-extensions/releases/latest) |
| **Firefox** | [📦 canvas-extension-firefox.zip](https://github.com/canvas-ui/canvas-browser-extensions/releases/latest) |

**Installation steps:**

**Chromium browsers (Chrome, Edge, Brave, etc.):**
1. Download the Chromium package
2. Extract the ZIP file
3. Open `chrome://extensions/`
4. Enable "Developer mode"
5. Click "Load unpacked"
6. Select the extracted folder

**Firefox:**
1. Download the Firefox package
2. Extract the ZIP file
3. Open `about:debugging`
4. Click "This Firefox"
5. Click "Load Temporary Add-on"
6. Select the `manifest.json` file from the extracted folder

### Method 3: Development Installation

For developers and testing:

1. **Install dependencies** (from browser extension directory):
   ```bash
   cd extensions/browser-extensions
   npm install
   ```

2. **Build the extension**:
   ```bash
   # Development build (unminified, with console logs)
   npm run build:dev
   
   # Production build (minified, optimized)
   npm run build
   ```

3. **Load in browser** (same steps as Method 2, but use `packages/chromium/` or `packages/firefox/` directories)

## Setup

1. **Install and run Canvas server** or **create an account via https://getcanvas.org**

2. **Open Canvas web interface and generate an API token**

3. **Configure extension**

## Browser Compatibility

- **Chrome**: v89+
- **Edge**: v89+
- **Firefox**: v109+
- **Brave**: v1.22+
- **Opera**: v75+

## License

Licensed under AGPL-3.0-or-later. See main project LICENSE file.

---
This project is funded by [Augmentd Labs](https://augmentd.eu/en/labs)
