---
title: "Example Markdown Post"
date: "12.15.2024"
tags: ["thoughts", "random"]
description: "This is an example post to demonstrate the markdown converter functionality."
---

## Example Markdown Post

This is an example post written in **markdown** format. The converter will automatically:

- Convert markdown to HTML
- Extract metadata from front matter
- Generate the proper HTML structure
- Update the archives list

## Features

The markdown converter supports:

1. **Headers** (like this one)
2. **Bold text** and *italic text*
3. **Lists** (both ordered and unordered)
4. **Links** - [like this one](https://example.com)
5. **Code blocks**:

```javascript
console.log("Hello, World!");
```

6. **Blockquotes**:

> This is a blockquote that will be styled according to your CSS.

## How to Use

Simply create a `.md` file in the `posts` directory with the following structure:

```yaml
---
title: "Your Post Title"
date: "MM.DD.YYYY"
tags: ["tag1", "tag2"]
description: "A brief description of your post"
---

Your markdown content goes here...
```

The converter will automatically generate the HTML file and update your archives list! 