- Right-Clicking a draft in the "Drafts" pane allows you to rename that draft without entering it
- Similarly, right-clicking a head commit and right-clicking a branch name allows you to rename it
- Similarly, right-clicking the highlight button allows you to change the highlight color
- Actually, right-clicking basically anything that has a name allows you to rename it
- Ctrl-click a link in the editor to open and switch to it in a new tab

Chat Pane:
- There are 3 main constructs in the chat pane:
- 1. Chats: These are, just like any other chat app, where you talk to an LLM. Right click in the chat lists page to rename chats
- 2. Stacks: These are a collection of messages that are sent to the LLM within a chat. This is an organizational construct to keep messages within a chat organized. For example, if in a single chat, you're talking about several different ideas, after each idea you can start a new stack to keep the messages about that idea together. Right click Stack names to rename them
- 3. Messages: These are the individual messages that you send to the LLM; LLM messages can contain Mentions and Suggestions within your document. You can Retry responses and Edit your previous messages.
- Ctrl+Enter = Send message and finish stack

Git Pane:
- Ctrl+Enter: Commit changes

Working Changes Viewing Modes
- Text: Just your average text editor. Type, delete, copy, paste, etc. Use for normal writing and editing text.
- Diff: Shows the differences between your working changes and the last commit. Use when you need to both 1) see what changes you have made and 2) continue making changes simultaneously. For example, when revising some writing you may want to have a clear indicator of what you've previously changed, to help you identify what you want to change next to fit the previous changes.
- Review: Shows the differences between your working changes and the last commit, but allows for easy reverting of changes. Use before you commit at the end of a long editing session to go through your changes and choose which to keep.

Editor Keyboard Shortcuts
- Ctrl+L: Select the next highest organizational unit (word, sentence, paragraph) of text. For example, if your cursor is in the middle of a word, Ctrl+L will select the entire word. If you Ctrl+L again, it will select the entire sentence. If you Ctrl+L again, it will select the entire paragraph.
- Alt+Up/Down: Move the current organizational unit up or down in the text. This is useful for rearranging sentences in a paragraph or rearranging paragraphs in a document.
- Alt+[ and Alt+]: Shift the current selection left or right by one organizational unit. For example, if you have a sentence selected, Alt+[ will select the previous sentence, and Alt+] will select the next sentence. If you have a paragraph selected, Alt+[ will select the previous paragraph, and Alt+] will select the next paragraph.
- Ctrl+[: Focus chat pane
- Ctrl+]: Focus editor pane
- Ctrl+8: Switch to Text view mode
- Ctrl+9: Switch to Diff view mode
- Ctrl+0: Switch to Review view mode
- Ctrl+/: Focus chat input box