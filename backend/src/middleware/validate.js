import { AppError } from './errorHandler.js';

export const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    try {
      const dataToValidate = req[source];
      const parsed = schema.parse(dataToValidate);
      req[source] = parsed;
      next();
    } catch (error) {
      if (error.errors) {
        const validationIssues = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message
        }));
        return next(new AppError('Request validation failed', 400, 'VALIDATION_ERROR', validationIssues));
      }
      return next(new AppError('Invalid request payload', 400, 'BAD_REQUEST'));
    }
  };
};
