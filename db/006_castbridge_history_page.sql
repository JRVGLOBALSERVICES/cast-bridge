-- Cast Bridge — the page each history entry was played from.
--
-- History rows kept only the video address. The page it was found on (a
-- bilibili.tv episode page, a season page) lived in the phone's local copy
-- alone, and any row that arrived from the server had the word "server" where
-- that page should be. Rj: "I can't click on the link and open it in Chrome
-- so I can get the next episode link." The page is the link that matters.
--
-- Additive and nullable: existing rows keep working and fill in as they are
-- played again. Applied to the production project 2026-09-12.

alter table castbridge.history add column if not exists page text;

notify pgrst, 'reload schema';
