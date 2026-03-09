(function () {
  "use strict";

  if (!window.UPSReports) return;

  window.UPSReports.register({
    id: "historical-archive",
    title: "Historical Archive",
    familyId: "historical",
    familyTitle: "Historical Reports",
    familyOrder: 6,
    kicker: "League Archive",
    description: "Draft, auction, trade, and scoring history across prior seasons.",
    status: "planned",
    render: function (ctx) {
      ctx.common.renderPlaceholder(ctx.root, {
        title: "Historical reporting is wired for expansion",
        body: "Archived draft, auction, and trade outputs can attach to this route family without disturbing current-season research tools.",
        items: [
          "Historical scoring leaders by season.",
          "Historical trades and draft recap views.",
          "Auction and draft archive summaries."
        ]
      });
    }
  });
})();
