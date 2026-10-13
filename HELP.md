- Right-Clicking a draft in the "Drafts" pane allows you to rename that draft without entering it
- Similarly, right-clicking a head commit and right-clicking a branch name allows you to rename it
- Similarly, right-clicking the highlight button allows you to change the highlight color
- Actually, right-clicking basically anything that has a name allows you to rename it
- On touch devices, long press is the equivalent of right click
- Ctrl-click a link in the editor to open and switch to it in a new tab

Chat Pane:
- There are 2 main constructs in the chat pane:
- Messages: Exactly what you think it is; you send a message, LLM responds w/ streaming MD that can include inline references to your document and one-click accept suggestions
- Comments: Like Delta (made by Zed), you can place your caret in the LLM's response; begin typing, and a comment will appear inline

Git Pane:
- Ctrl+Enter: Commit changes

Working Changes Viewing Modes
- Text: Just your average text editor. Type, delete, copy, paste, etc. Use for normal writing and editing text.
- Diff: Shows the differences between your working changes and the last commit. Use when you need to both 1) see what changes you have made and 2) continue making changes simultaneously. For example, when revising some writing you may want to have a clear indicator of what you've previously changed, to help you identify what you want to change next to fit the previous changes.
- Review: Shows the differences between your working changes and the last commit, but allows for easy reverting of changes. Use before you commit at the end of a long editing session to go through your changes and choose which to keep.

Editor Keyboard Shortcuts
- Ctrl+L: Expand a caret or word selection to the sentence, then the paragraph. Pressing Ctrl+L again on a selected paragraph loops back to the word at the original caret position.
- Alt+Up/Down: Move the current organizational unit up or down in the text. This is useful for rearranging sentences in a paragraph or rearranging paragraphs in a document. The original caret position moves with the content.
- Alt+[ and Alt+]: Shift the current selection left or right by one organizational unit. For example, if you have a sentence selected, Alt+[ will select the previous sentence, and Alt+] will select the next sentence. The original caret position moves with the selection.
- Escape: Collapse the current selection to the position where the selection began. For selections expanded or moved with the shortcuts above, this returns to the tracked original caret position.
- Ctrl+;: Focus the editor pane and the editor (on the home page, focus the empty editor to start a new draft)
- Ctrl+[: Focus chat pane
- Ctrl+]: Focus editor pane
- Ctrl+8: Switch to Text view mode
- Ctrl+9: Switch to Diff view mode
- Ctrl+0: Switch to Review view mode
- Ctrl+8, Ctrl+9 on the home page: Switch the draft list to Recents or Folders
- Ctrl+/: Focus chat input box

Editor Features
- Auto-Detect/Calculate math: Type in any math formula and it will be automatically rendered in LaTeX. If you enter a calculation (must end with an equals sign), it will be automatically calculated and the result will be displayed. For example, typing "2+2=" will display "4" in the editor.
  - For division, you may need to add parentheses to trigger math rendering. For example, instead of '6/30', type '(6)/30'. This is to avoid confusion between the shorthand for the date June 30th and the fraction 6 divided by 30.
- Formatting Lock: You can lock formatting in the editor so that it stays the same no matter what formatting is underneath your Caret. This is useful for filling out forms, where you want your responses to have different formatting than the questions.

Exporting:
- All math will be correctly exported; in Diff mode, exports include green for additions and red strikethroughs for deletions

Folders:
- Move > Reorder on a folder: Click a line between its sibling folders to place it there. Esc or a click elsewhere cancels.
- Alt+Up/Down on a focused folder: Move it up or down among its siblings
- Alt+Right on a focused folder: Nest it inside the folder above it; Alt+Left moves it back out, directly after its parent
- On the initial commit of each document, the document will be automatically assigned to an existing folder if there is a relevant folder based on its content and the names of the folders