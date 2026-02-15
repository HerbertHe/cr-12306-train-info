declare namespace API {
  export interface IResponse<T> {
    code: number;
    success: boolean;
    message: string;
    data?: T;
  }
}