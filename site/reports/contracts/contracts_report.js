(function () {
  "use strict";

  if (!window.UPSReports) return;

  window.UPSReports.register({
    id: "contracts-overview",
    title: "Contracts Overview",
    familyId: "contracts",
    familyTitle: "Contract Reports",
    familyOrder: 2,
    kicker: "Contract Analytics",
    description: "Active contracts, timeline snapshots, and guaranteed exposure.",
    status: "planned",
    render: function (ctx) {
      ctx.common.renderPlaceholder(ctx.root, {
        title: "Contract reporting will sit beside scoring, not inside it",
        body: "This module is reserved for contract-specific views so salary, extension, and exposure logic stay isolated from player production analytics.",
        items: [
          "Active contract register with extension and guarantee context.",
          "Contract timeline by player and franchise.",
          "Guaranteed exposure summaries for cap planning."
        ]
      });
    }
  });
})();
