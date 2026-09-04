/**
 * Revflow — Recovery Lab Controller
 *
 * Exposes isolated demonstration endpoints that execute purely in-memory
 * scenarios without touching production PostgreSQL or external APIs.
 */

const { listScenarios, runScenario, DEMO_SCENARIOS } = require('../services/recoveryLabService');

function createRecoveryLabController() {
  return {
    listScenarios: (request, response) => {
      return response.status(200).json({
        provenance: 'DEMO / SIMULATION',
        scenarios: listScenarios()
      });
    },

    runScenario: async (request, response, next) => {
      try {
        const { scenarioId, options = {} } = request.body || {};

        if (!scenarioId || typeof scenarioId !== 'string') {
          return response.status(400).json({
            error: 'BAD_REQUEST',
            message: 'Request body must include a valid string "scenarioId".',
            validScenarios: Object.keys(DEMO_SCENARIOS)
          });
        }

        if (!DEMO_SCENARIOS[scenarioId]) {
          return response.status(404).json({
            error: 'SCENARIO_NOT_FOUND',
            message: `Unknown demo scenario '${scenarioId}'.`,
            validScenarios: Object.keys(DEMO_SCENARIOS)
          });
        }

        const result = await runScenario(scenarioId, options);
        return response.status(200).json(result);
      } catch (error) {
        return next(error);
      }
    }
  };
}

module.exports = {
  createRecoveryLabController
};
