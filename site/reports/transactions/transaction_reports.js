(function () {
  "use strict";

  if (!window.UPSReports) return;

  window.UPSReports.register({
    id: "transaction-history",
    title: "Transaction History",
    familyId: "transactions",
    familyTitle: "Transaction Reports",
    familyOrder: 4,
    kicker: "League Activity",
    description: "Add/drop history, trade activity, and franchise transaction trails.",
    status: "planned",
    render: function (ctx) {
      ctx.common.renderPlaceholder(ctx.root, {
        title: "Transaction reports are queued behind the shared shell",
        body: "The family route is active now so transaction-specific datasets can be added later without refactoring the reports page.",
        items: [
          "League-wide add/drop history.",
          "Franchise transaction timelines.",
          "Waiver and trade activity rollups."
        ]
      });
    }
  });
})();
