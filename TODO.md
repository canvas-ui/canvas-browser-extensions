# TODO

## Generic
- Inserting tabs to a path regardless of how should show up in the history in our context menu, currently this only happens if documents are inserted using the context menu (or maybe context menus are not getting refreshed properly)

## Backend features

- Add support for multiple trees
- Add "save website" functionality
  - Default storage backend "workspace" which will create a copy of the website in WORKSPACE_ROOT/data/a/website/<ulid>.html
    - backend concern, blocked by canvas-server, more details in the canvas-server repo
  - Support opening a stored website instead of a live one
  - Codebase should be inspired by https://github.com/gildas-lormeau/singlefile
  - Needs proper UI toggles, bells and whistles
