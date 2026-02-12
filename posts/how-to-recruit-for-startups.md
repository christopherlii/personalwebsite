---
title: "How to Recruit for Startups"
date: "2026-01-05"
tags: ["random"]
description: "Advice on breaking into the startup scene—less luck, more strategy."
---

A few of my friends have asked me recently for advice on breaking into the startup scene. I've discovered that, through trial and error, the process is much less luck based compared to traditional big tech companies.

Startups essentially care only about three things:
- How you can provide value to them
- Evidence that you've provided value in the past
- You're actually kind of interested in what they do

It's important to recognize that your success depends entirely on your ability to convey those three things. I wouldn't spend too much time practicing Leetcode or memorizing behavioral questions. If you're a student, knowing a project inside out or having a big tech internship helps immensely.

I'd like to add that increasing your visibility is probably a higher EV strategy to cold emailing. For a baseline applying/interviewing strategy, this works fine, but optimizing for visibility allows opportunities to find you AND closer aligns value propositions for both parties. By getting people to know, recommend, and like you, your scope of opportunities increases exponentially.

It goes something along the lines of build/do cool things --> tell people about it --> develop relationships with said people --> find more situations and more people to build cool things in/with --> repeat. I'd honestly do this instead. If you're too shy to do so—I definitely was for most of college—then the strategy I've outlined below is generally a decent alternative.

Anyways, once you've figured out your core value prop, here's the workflow I used:

## 1. Sourcing

This one's pretty simple. I kept a spreadsheet of startups that I added to every time I came across companies on LinkedIn, Twitter, or TechCrunch I thought would be cool to work at. After, go to apollo.io and write down the name/emails of people that might be relevant to where you'll be working. For me, those were the CEO, CTO, Head/VP of Eng, any Tech Leads. I stuck to emailing 2-3 per company.

You can also find lists of startups, like [this one here](https://www.pampam.city/soho-valley-Pd82Tp8aq5EfxTP3yJhu?40.724523%2C-73.994322%2C14.81=). Aim for companies that just raised, especially a Series B/C (which is typically around when hiring ramps up aggressively).

## 2. Cold Emailing

Now we just need outreach. I'd first write out a template that you can mass send. Keep it short, and personable. Say things that sound like you've done research on the company, like "I'm extremely impressed by how fast [company] ships, and want to be a part of that culture" (every company that's raised money ships fast, and believes they're unique in that regard). Even better if you've actually done research and can talk about the company/product. Again, keep it short—I deliberately mention this in my first sentence—you're only trying to convey three things. Here was my script:

```
Hi ${NAME},

I'll keep this short—I believe in ${COMPANY}'s mission and love the speed
and togetherness of the team. I'm taking a gap semester from NYU, and
would love to contribute this fall.

My previous experiences include SWE internships at Amazon and a startup,
multiple full stack projects using Java, Python, and the MERN stack, and
a hackNYU win. I've attached my resume for context.

I'm excited to start shipping at ${COMPANY} and help shape its
culture—also open to growth/PM roles. Would you be free for a 15 minute
chat next week?

Best,
Christopher Li
```

A couple notes:
- It's extremely clear how I can provide value (shipping fast, on a gap, belief in the mission), that I've done it before (Amazon, hackNYU win), and that I'm excited to start immediately. Note that it is also completely fine if the value you provide isn't what they're looking for!
- There's an ACTION ITEM at the end. This is crucial. In your outreach, you need to be directly asking them for something, a clear next step—they'll see no reason to respond otherwise.
- Aim for brevity. Keep the sentences short and the paragraphs shorter. Here's an example of a bad sentence: It's pretty useful to follow a "LinkedIn" style of writing, where the attention commitment required to make it to the end of a block of "thought" is relatively low. The only large blocks should be your experience dump, and even then, keep it at 2-3 items at most.
- I found that response rates to this template hovered around 50%, with maybe half of those leading to a real conversation/interview process.

## 3. Automation

Again, pretty easy. I'd ask gpt to format my spreadsheet into a raw CSV file. This is essentially just plain text in the form of:
```
NAME,EMAIL,COMPANY
```
Next, throw that CSV into a Python script that can automatically send emails for you. If you're non technical, ask gpt to write you one.

## 4. Interviewing

Most of these startups won't ask traditional Leetcode questions. They're trying to gauge your ability in situations very similar to what they see day to day. This might be coding a feature with Cursor, take homes, or debugging a codebase. There isn't really a way to prepare for this interviewing style apart from coding consistently day to day.

The journey is pretty stressful, but well worth it. Working at a startup in your early 20s steepens your growth curve significantly. Good luck!
