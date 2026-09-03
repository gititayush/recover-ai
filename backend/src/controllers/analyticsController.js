/**
 * Revflow V2 — Recovery Outcome Analytics Controller
 */

const { getOverallOutcomeAnalytics } = require('../services/outcomeAnalyticsService');

function createAnalyticsController(repository) {
  return {
    async handleGetAnalytics(request, response, next) {
      try {
        const analytics = await getOverallOutcomeAnalytics(repository);
        return response.status(200).json(analytics);
      } catch (error) {
        return next(error);
      }
    },

    async handleGetStrategyAnalytics(request, response, next) {
      try {
        const analytics = await getOverallOutcomeAnalytics(repository);
        return response.status(200).json({
          dataProvenance: analytics.dataProvenance,
          isSimulated: analytics.isSimulated,
          generatedAt: analytics.generatedAt,
          strategies: analytics.strategyPerformance
        });
      } catch (error) {
        return next(error);
      }
    },

    async handleGetFailureAnalytics(request, response, next) {
      try {
        const analytics = await getOverallOutcomeAnalytics(repository);
        return response.status(200).json({
          dataProvenance: analytics.dataProvenance,
          isSimulated: analytics.isSimulated,
          generatedAt: analytics.generatedAt,
          failures: analytics.failureAnalytics
        });
      } catch (error) {
        return next(error);
      }
    },

    async handleGetVelocityAnalytics(request, response, next) {
      try {
        const analytics = await getOverallOutcomeAnalytics(repository);
        return response.status(200).json({
          dataProvenance: analytics.dataProvenance,
          isSimulated: analytics.isSimulated,
          generatedAt: analytics.generatedAt,
          recoveryVelocity: analytics.recoveryVelocity
        });
      } catch (error) {
        return next(error);
      }
    }
  };
}

module.exports = {
  createAnalyticsController
};
