# Post AEO/GEO — Launch posts

> Adam : à adapter à ta voix avant de poster.

---

## Version Reddit (r/SEO)

**Title:** Mapped share of voice for 5 brands in one niche, some findings + the tool I used

**Body:**

I've been messing with buyer-intent queries lately, the "best X for Y" searches that drive actual purchase decisions. Wanted to see who really owns those results vs. who just thinks they do.

Example: I picked Notion and let the tool infer competitors + relevant queries.

Results:
"best project management tool" Asana #2, Notion #3, ClickUp #4. Notion doesn't own the generic category search.
"notion alternative" Notion #1 (obviously), Obsidian #2, Coda #6. The branded alternative query has completely different page types ranking (comparison posts vs. homepages).

The gap between those two queries is where the actual GEO/AEO work lives and it's not something you can see from a rank tracker that only checks your own brand keywords.

I built a small tool to automate this. You type a brand, it uses Claude to figure out competitors and buyer queries, runs them against live Google via Bright Data, and also checks which brands AI engines would recommend for the same queries. You get a dual heatmap, SERP ranks vs. AI mentions, side by side.

The AI engine check is interesting because it shows different rankings than Google. Brands with strong awareness get boosted in AI answers even if they don't rank as well on SERP. That delta is where AEO work actually lives.

Free to use, no signup: https://brandpulse-app.onrender.com

Open source if you want to run it on your own keys: https://github.com/arochab/brandpulse-app

If it saves you time, buy me a coffee https://buymeacoffee.com/arochab and we're more than even.

Curious what you'd do differently. Are there other signals beyond SERP rank and AI mentions that would be worth tracking for AEO?

---

## Version Reddit (r/SaaS)

**Title:** I built a free competitive visibility tool and engineered it to stay free forever

**Body:**

I'm a solo dev. I wanted to know whether my product shows up when someone searches "best [tool] for [use case]" and I didn't want to pay $200/mo to find out.

So I built a tool that takes one brand name, uses Claude Haiku to figure out the competitive set and buyer-intent queries, then runs live Google searches and checks which brands AI would recommend for the same questions.

The design constraint I gave myself was to make it so cheap per run that I never have to charge for it.

Here's how the architecture achieves that. I use the cheapest LLM that can do structured reasoning (Claude Haiku), two calls per analysis, both tiny. Only 2 SERP API calls per run which is the minimum to get useful competitive data. Persistent cache so once a brand is analyzed it's served from cache forever, zero marginal cost on repeat visits. Hosting on Render free tier with the trade-off of a 30s cold start on first visit.

The result is each analysis costs a fraction of a cent. I could run thousands of these a day and still spend less than my morning coffee. So it's free and it stays free.

Stack is Python/Flask (one file, no bloat), Claude Haiku for LLM, Bright Data for SERP, vanilla JS frontend, deployed on Render with gunicorn.

What I'd do differently next time: the 30 second cold start on Render free tier is a real conversion killer. If I were serious about growth I'd move to a paid instance. Also 2 SERP queries per analysis is the minimum viable insight, expanding to 4 or 5 would give better data.

Free to try: https://brandpulse-app.onrender.com
Source: https://github.com/arochab/brandpulse-app

If it's useful, buy me a coffee https://buymeacoffee.com/arochab that's genuinely more than enough to cover the server costs.

Happy to go deeper on the architecture decisions or the Claude prompt engineering if anyone's interested.
