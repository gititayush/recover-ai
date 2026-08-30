const express = require('express');
const { createCaseController } = require('../controllers/caseController');

function createCaseRouter(repository) {
  const router = express.Router();
  const controller = createCaseController(repository);
  router.get('/', controller.list);
  router.get('/:id', controller.getById);
  return router;
}

module.exports = { createCaseRouter };
