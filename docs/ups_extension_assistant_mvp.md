# UPS Extension Assistant MVP

---

## 1. Bot Purpose

The UPS Extension Assistant is a focused help tool for league owners who want to extend a player's contract.

It answers one category of questions: **how to understand, find, and complete a player extension on the UPS Dynasty League website.**

It does not answer questions about trades, restructures, tags, MYM actions, reports, or league rules. If an owner asks about those topics, the bot will redirect them to the right place.

The bot is designed to give fast, confident answers so an owner can complete an extension without guessing.

---

## 2. Supported Questions

This MVP bot is built to answer the following types of questions:

**Navigation**
- Where do I go to extend a player?
- What module handles extensions?
- How do I find the extension page?

**Eligibility**
- How do I know if a player is eligible for an extension?
- Why is my player not showing up?
- Why can't I extend this player?

**Workflow**
- How do I extend a player?
- What steps do I follow to submit an extension?
- How do I choose the extension term?
- What do I review before I submit?

**Confirmation**
- How do I know if my extension went through?
- Where do I check submitted extensions?
- Why is my submission not showing?

**Terms**
- What does AAV mean?
- What does TCV mean?
- What does years remaining mean?
- What is an eligible player?
- What is a finalized submission?

**Warnings**
- What does it mean when there is no extension option available?
- Why do the contract values look different than I expected?
- I submitted an extension but I do not see it. What do I do?

---

## 3. Owner Workflow: How to Extend a Player

Follow these steps in order. The whole process takes about two minutes.

**Step 1 — Open Contract Command Center**
From the league site navigation, open **Contract Command Center**.

**Step 2 — Select the Extend Player action**
At the top of the page, choose the action labeled **Extend Player**.

**Step 3 — Find your player**
Use the team filter, position filter, or search field to locate the player you want to extend. Only eligible players will appear in this list.

**Step 4 — Select the player**
Click on the player. If a player does not appear, they are not currently eligible for an extension.

**Step 5 — Choose the extension term**
Select from the available extension term options shown on the screen. If only one option is shown, that is the only term available.

**Step 6 — Review the contract summary**
The page will show you the updated contract values including salary, AAV, TCV, and years remaining. Review these carefully before continuing.

**Step 7 — Submit the extension**
When you are satisfied with the contract summary, submit the extension.

**Step 8 — Confirm your submission**
After submitting, check the **Finalized Submissions** area inside Contract Command Center. Your extension should appear there. If it does, the action has been recorded successfully.

---

## 4. Extension Terms Glossary

**Extension**
A contract action that adds more years to a player's existing deal. When you extend a player, their contract is recalculated with the new term and updated salary values.

**AAV (Average Annual Value)**
The average salary per year across the full contract. A four-year, $20M contract has an AAV of $5M per year. This is the number used most often for cap planning.

**TCV (Total Contract Value)**
The total dollars across all years of the contract. If a player's contract pays $4M, $5M, and $6M over three years, the TCV is $15M.

**Years Remaining**
How many seasons are left on the player's current contract, including the year being extended into. A player in year one of a two-year deal has one year remaining after this season.

**Eligible Player**
A player who qualifies for an extension under the current league rules. Only eligible players appear in the Extend Player action list. If a player is not on the list, they are not eligible right now.

**Submitted Extension**
An extension that has been sent through the system but may still be pending review or processing. You can view submitted extensions in the submissions area of Contract Command Center.

**Finalized Submission**
An extension that has been recorded and confirmed. When your extension appears in the Finalized Submissions view, the action is complete. This is the confirmation you are looking for after you submit.

---

## 5. Common Warnings

**Player not eligible**
If a player does not appear in the Extend Player list, they are not currently eligible for an extension. This could be because their contract type, years remaining, or roster status does not qualify under league rules. You cannot override this in the system. If you believe this is an error, contact the commissioner.

**No available extension option**
If you can select a player but see no term options, there are no valid extension lengths available for that player at this time. Wait until an option becomes available or check with the commissioner about eligibility timing.

**Submission not showing**
If you submitted an extension and it does not appear in the Finalized Submissions area, try refreshing the page. If it still does not show after a refresh, do not resubmit. Contact the commissioner with the player's name and the date you submitted.

**Wrong page or module**
Extensions are only processed in **Contract Command Center** under the **Extend Player** action. If you are looking at a different page and trying to submit an extension, you are in the wrong place. Navigate back to Contract Command Center.

**Contract values look unexpected**
The contract values shown in the review step are calculated by the system based on the extension term and league rules. You cannot manually change these values. If the numbers look wrong to you, review the terms glossary above or contact the commissioner before submitting. Do not submit if you are unsure.

---

## 6. Bot Response Framework

Every bot answer should follow this structure:

1. **Name the correct module and page.** Tell the owner exactly where to go first.
2. **Give the next steps.** Keep it to the fewest steps needed to answer the question.
3. **Explain any warning if it applies.** Only include warning context if it is relevant to the question.
4. **End with a clear action.** Tell the owner exactly what to do or check next.

**Example structure in plain language:**

> Go to **Contract Command Center** and select **Extend Player**.
> [Steps.]
> If you see [warning], it means [plain explanation].
> When you are done, confirm the extension appears in **Finalized Submissions**.

---

## 7. Example Bot Responses

---

**Q: How do I extend a player?**

Go to **Contract Command Center** from the navigation menu and select **Extend Player**.

Find your player using the search field or filters. Select the player, choose the extension term, review the contract summary, and submit. After submitting, open **Finalized Submissions** to confirm the extension is recorded.

---

**Q: Where do I go to submit an extension?**

All extensions are handled in **Contract Command Center**. Open that module from the league navigation, then choose the **Extend Player** action at the top of the page.

---

**Q: Why can't I extend this player?**

If a player does not appear in the **Extend Player** list, they are not currently eligible for an extension. Only eligible players are shown. Check whether the player's contract status or roster status may be limiting eligibility. If you believe it is a mistake, contact the commissioner.

---

**Q: My player shows up but there is no term to select. What do I do?**

This means there are no valid extension terms available for that player right now. You cannot submit an extension without a term option. Wait for an eligible window to open, or ask the commissioner about that player's extension timing.

---

**Q: How do I know if my extension went through?**

After submitting, go to the **Finalized Submissions** area inside **Contract Command Center**. If your extension appears there, it has been successfully recorded. If it does not appear, refresh the page and check again. Do not resubmit without checking first.

---

**Q: What does AAV mean?**

AAV stands for Average Annual Value. It is the average salary per year across the full contract. For example, a $12M contract over three years has an AAV of $4M per year. It is the most common number used when comparing cap impact across players.

---

**Q: What does TCV mean?**

TCV stands for Total Contract Value. It is the full dollar amount of the contract across all years combined. A player earning $3M, $4M, and $5M over three years has a TCV of $12M.

---

**Q: I submitted an extension but it is not showing up. What do I do?**

First, refresh the page and check **Finalized Submissions** again. If it still does not appear, do not submit again. Contact the commissioner and provide the player's name and the date and time you submitted. The commissioner can verify whether the action was recorded on the backend.

---

**Q: What does years remaining mean?**

Years remaining is the number of seasons left on a player's current contract after the current year. A player in year two of a three-year deal has one year remaining. This number matters for extension eligibility because some extension rules depend on where a player is in their contract.

---

**Q: The contract values after I select a term look different than I expected. Is that normal?**

Yes. The system calculates contract values automatically based on the extension term and league rules. You cannot change these values manually. If the numbers look wrong to you, do not submit yet. Review the terms glossary or contact the commissioner to clarify before proceeding.

---

**Q: I am on the wrong page. Where do I go to extend a player?**

Go back to the main navigation and open **Contract Command Center**. Once you are there, choose **Extend Player** from the action list at the top. Extensions cannot be submitted from any other page.

---

## 8. MVP UI Recommendation

**Recommended approach: Contextual help panel on the Contract Command Center page, scoped to the Extend Player action.**

When an owner selects the **Extend Player** action, a collapsible help panel appears on the right side or bottom of the screen. The panel contains:

- A short workflow summary (Steps 1 through 8 from Section 3)
- A searchable or scrollable list of common questions from Section 2
- A glossary tab with the terms from Section 4
- A warnings tab with the issues from Section 5

No chatbot interface is needed for the MVP. A static help panel with organized sections is faster to build, easier to maintain, and sufficient for the scope of extension-only questions.

If a question is outside extension scope, the panel shows a single line: *For help with restructures, trades, or other actions, contact the commissioner.*

This is the lowest-effort, highest-value implementation for an MVP. It requires no AI backend. It surfaces help exactly where the owner needs it.

---

## 9. Future Enhancements

This MVP focuses only on extensions. The same structure can be expanded in later phases.

**Restructure Assistant**
Use the same help panel framework on the Restructure action inside Contract Command Center. Swap the workflow, glossary, and warnings to cover restructure-specific steps and terms. No new architecture needed.

**Trade Assistant**
Apply the same pattern to the Trade War Room. The workflow is more complex because trades involve players, picks, traded salary, and pre-trade extensions. Build this as its own panel after the extension and restructure panels are stable.

**Full League Assistant**
Once all individual action panels are built and tested, combine them into a league-wide assistant. At that point, the assistant can route owners to the right module based on their question. This is where a real AI backend or search layer would add value. Do not build this until the individual panels have been validated with real owner questions.

Build in that order. Validate each phase before expanding.
