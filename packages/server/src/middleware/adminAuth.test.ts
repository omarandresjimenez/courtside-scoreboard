import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { adminAuth } from './adminAuth.js';

function fakeReqRes(headerValue?: string) {
  const req = { header: jest.fn().mockReturnValue(headerValue) } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

describe('adminAuth', () => {
  it('rejects a missing password with 401', () => {
    const { req, res, next } = fakeReqRes(undefined);
    adminAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid admin password.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a wrong password with 401', () => {
    const { req, res, next } = fakeReqRes('definitely-wrong');
    adminAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when the password matches', () => {
    const { req, res, next } = fakeReqRes(config.adminPassword);
    adminAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
