function createCaseController(repository) {
  return {
    list: async (request, response, next) => {
      try { response.json({ cases: await repository.listCases() }); } catch (error) { next(error); }
    },
    getById: async (request, response, next) => {
      try {
        const detail = await repository.getCaseDetail(request.params.id);
        if (!detail) return response.status(404).json({ error: 'CASE_NOT_FOUND', message: 'Recovery case not found.' });
        return response.json(detail);
      } catch (error) { return next(error); }
    }
  };
}

module.exports = { createCaseController };
