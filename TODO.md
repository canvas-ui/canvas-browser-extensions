# TODO

## Backend features

- Add support for multiple trees
- Add "save website" functionality
  - Default storage backend "workspace" which will create a copy of the website in WORKSPACE_ROOT/data/a/website/<ulid>.html
    - backend concern, blocked by canvas-server, more details in the canvas-server repo
  - Support opening a stored website instead of a live one
  - Codebase should be inspired by https://github.com/gildas-lormeau/singlefile
  - Needs proper UI toggles, bells and whistles
