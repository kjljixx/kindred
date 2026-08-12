Editor
- Format Lock; everything you type stays in the same format even if you move your cursor
- Add highlighting text
- Add Links
- Google Fonts for a larger variety of fonts
- Investigate/Fix Sentence feedback being lost when replacing large amounts of a sentence
- Investigate/Fix adding new paragraphs breaking some stuff
- Fix sentences/paragraphs not highlighting
- Somehow detect if what got pasted in was code or text? and maybe do syntax highlighting accordingly?
- Lists & Tables

Settings
- Setting for the Model - Low
- Whether branches sort by last commit time or last access time

Feedback
- Streaming feedback - Low
- Improve the prompt given - it kinda sucks rn
- Allow it to see merge stuff 
- Rename pane to "Chat"
- Allow chats to still be used even if not analyzed yet.

Git
- Look at git-appraisal implementation for comments (or maybe tiptap comments are possible?)
- Make Ctrl+Y/Z work in merge conflict resolution
- Pinning branches - each pinned branch gets a position index equal to the position they were originally in when pinned. When making the ordered list, pinned branches are sorted by their position index, and unpinned branches are sorted by last commit/access time. Unpinned branches are slotted in order into spots left empty by pinned branches.
- Staging

Keyboard Shortcuts
- VSCode like keybinds for editor - Ctrl + L to copy sentence, Alt Up/Down to move sentence, etc.

Import/Export
- From Google Drive
- From HTML of a website

Status bar
- the ui here is a bit of a mess, should prob be STATUS | word/char count | git branch/commit hash --------------- model, model cost
- Show ephemeral error when user tries to trigger an analysis during review/merge mode

AI generated titles - show1 titles at top of editor/make sure they are not just one letter

Syncing
- Sync to central server